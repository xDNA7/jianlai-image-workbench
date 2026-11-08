use serde_json::Value;
use sqlx::{migrate::Migrator, postgres::PgPoolOptions, PgPool};

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct PostgresShadowRepository {
    pool: PgPool,
}

pub async fn connect_optional(
    url: Option<&str>,
    primary: bool,
) -> Result<Option<PostgresShadowRepository>, sqlx::Error> {
    let Some(url) = url.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    // Primary mode is deliberately a single native VPS process. The only
    // business session also owns the singleton lease; there is no separate
    // pool that could continue writing after the lease session disappears.
    let opened = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let options = PgPoolOptions::new()
        .max_connections(if primary {1} else {8})
        .min_connections(1)
        .max_lifetime(None)
        .idle_timeout(None)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .after_connect(move |connection,_| {
            let opened=opened.clone();
            Box::pin(async move {
                if primary {
                    if opened.swap(true,std::sync::atomic::Ordering::SeqCst) {
                        return Err(sqlx::Error::Protocol("primary lease session lost; restart required".into()));
                    }
                    let acquired:bool=sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended('jianlai-image-workbench:primary:' || current_database(),0))").fetch_one(&mut *connection).await?;
                    if !acquired {return Err(sqlx::Error::Protocol("PostgreSQL primary lease already held by another process".into()));}
                    sqlx::query("SET application_name='jianlai-primary'").execute(&mut *connection).await?;
                }
                Ok(())
            })
        });
    let pool = tokio::time::timeout(std::time::Duration::from_secs(3), options.connect(url))
        .await
        .map_err(|_| sqlx::Error::PoolTimedOut)??;
    MIGRATOR.run(&pool).await?;
    if primary {
        let monitored = pool.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                interval.tick().await;
                if !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(6),
                        sqlx::query("SELECT 1").execute(&monitored)
                    )
                    .await,
                    Ok(Ok(_))
                ) {
                    tracing::error!(exiting = true, "postgres_primary_lease_lost");
                    std::process::exit(1);
                }
            }
        });
    }
    Ok(Some(PostgresShadowRepository { pool }))
}

impl PostgresShadowRepository {
    pub(crate) fn pool(&self) -> PgPool {
        self.pool.clone()
    }

    pub async fn health(&self) -> Result<(), sqlx::Error> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_job(
        &self,
        id: &str,
        account: &str,
        request_key: &str,
        created: i64,
        params: &Value,
        reserved: i64,
        fingerprint: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO jobs (id, account, request_key, status, created, params, reserved, fingerprint)
             VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
             ON CONFLICT (account, request_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint",
        )
        .bind(id).bind(account).bind(request_key).bind(created)
        .bind(params).bind(reserved).bind(fingerprint)
        .execute(&self.pool).await.map(|_| ())
    }

    pub async fn update_job(
        &self,
        id: &str,
        status: &str,
        phase: &str,
        charged: i64,
        result: &Value,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE jobs SET status=$2, phase=$3, charged=$4, reserved=0, result=$5 WHERE id=$1",
        )
        .bind(id)
        .bind(status)
        .bind(phase)
        .bind(charged)
        .bind(result)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_video(
        &self,
        id: &str,
        account: &str,
        request_key: &str,
        fingerprint: &str,
        created: i64,
        reserved: i64,
        prompt: &str,
        duration: i64,
        ratio: &str,
        resolution: &str,
        input_key: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO video_jobs (id,account,request_key,fingerprint,status,phase,created,reserved,prompt,duration,ratio,resolution,input_key)
             VALUES ($1,$2,$3,$4,'queued','queued',$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (account, request_key) DO UPDATE SET fingerprint=EXCLUDED.fingerprint",
        )
        .bind(id).bind(account).bind(request_key).bind(fingerprint).bind(created)
        .bind(reserved).bind(prompt).bind(duration).bind(ratio).bind(resolution).bind(input_key)
        .execute(&self.pool).await.map(|_| ())
    }

    pub async fn update_video(
        &self,
        id: &str,
        status: &str,
        phase: &str,
        charged: i64,
        url: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE video_jobs SET status=$2,phase=$3,reserved=0,charged=$4,video_url=$5,error=$6 WHERE id=$1")
            .bind(id).bind(status).bind(phase).bind(charged).bind(url).bind(error)
            .execute(&self.pool).await.map(|_| ())
    }

    pub async fn set_ledger(&self, balance: i64) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO shared_ledger (id,balance) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET balance=EXCLUDED.balance")
            .bind(balance).execute(&self.pool).await.map(|_| ())
    }

    pub async fn insert_recharge(
        &self,
        id: &str,
        request_key: &str,
        amount: i64,
        created: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO recharges (id,request_key,amount,created) VALUES ($1,$2,$3,$4) ON CONFLICT (request_key) DO NOTHING")
            .bind(id).bind(request_key).bind(amount).bind(created)
            .execute(&self.pool).await.map(|_| ())
    }
}
