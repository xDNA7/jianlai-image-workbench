use crate::*;
use std::path::Path;

pub fn migrate(db: &Connection) -> rusqlite::Result<()> {
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,token TEXT UNIQUE,balance INTEGER NOT NULL DEFAULT 10000);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,account TEXT,requestKey TEXT,status TEXT,charged INTEGER DEFAULT 0,created INTEGER,params TEXT,result TEXT,UNIQUE(account,requestKey));
CREATE TABLE IF NOT EXISTS video_jobs(id TEXT PRIMARY KEY,account TEXT NOT NULL,requestKey TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,created INTEGER NOT NULL,started INTEGER,reserved INTEGER NOT NULL DEFAULT 0,charged INTEGER NOT NULL DEFAULT 0,prompt TEXT NOT NULL,duration INTEGER NOT NULL,ratio TEXT NOT NULL,resolution TEXT NOT NULL,input_url TEXT,input_key TEXT,provider_id TEXT,video_url TEXT,error TEXT,UNIQUE(account,requestKey));
CREATE INDEX IF NOT EXISTS video_jobs_account_created ON video_jobs(account,created DESC);
CREATE INDEX IF NOT EXISTS video_jobs_active_reserved ON video_jobs(status,reserved) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS shared_ledger(id INTEGER PRIMARY KEY CHECK(id=1),balance INTEGER NOT NULL CHECK(balance>=0));
INSERT OR IGNORE INTO shared_ledger(id,balance) VALUES(1,50000);
CREATE TABLE IF NOT EXISTS stored_images(job TEXT NOT NULL,idx INTEGER NOT NULL,account TEXT NOT NULL,file TEXT NOT NULL,type TEXT NOT NULL,created INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,object_url TEXT,preview_url TEXT,PRIMARY KEY(job,idx));
CREATE INDEX IF NOT EXISTS images_account_created ON stored_images(account,created DESC,job,idx);
CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recharges(id TEXT PRIMARY KEY,requestKey TEXT UNIQUE NOT NULL,amount INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS template_assets(id TEXT PRIMARY KEY,file TEXT NOT NULL,type TEXT NOT NULL,created INTEGER NOT NULL,task TEXT,templateId TEXT,used INTEGER NOT NULL DEFAULT 0,object_url TEXT,preview_url TEXT);
CREATE TABLE IF NOT EXISTS author_tasks(id TEXT PRIMARY KEY,requestKey TEXT UNIQUE NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,jobId TEXT,result TEXT,error TEXT,assetId TEXT);")?;
    let cols = db
        .prepare("PRAGMA table_info(jobs)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, def) in [
        ("reserved", "INTEGER NOT NULL DEFAULT 0"),
        ("fingerprint", "TEXT"),
        ("phase", "TEXT"),
        ("started", "INTEGER"),
    ] {
        if !cols.iter().any(|s| s == name) {
            db.execute_batch(&format!("ALTER TABLE jobs ADD COLUMN {name} {def}"))?;
        }
    }
    let author_columns = db
        .prepare("PRAGMA table_info(author_tasks)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !author_columns.iter().any(|c| c == "fingerprint") {
        db.execute_batch(
            "ALTER TABLE author_tasks ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
        )?;
    }
    let stale_video: Vec<(String, i64)> = {
        let mut stmt=db.prepare("SELECT id,reserved FROM video_jobs WHERE status IN ('queued','running') AND (provider_id IS NULL OR started IS NULL OR started<?)")?;
        stmt.query_map([now() - 24 * 60 * 60 * 1000], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    for (job, _reserved) in stale_video {
        db.execute("UPDATE video_jobs SET status='failed',phase='failed',reserved=0,error='服务重启后任务中断，额度已退回' WHERE id=?",[job])?;
    }
    for (table, name) in [
        ("stored_images", "object_url"),
        ("stored_images", "preview_url"),
        ("template_assets", "object_url"),
        ("template_assets", "preview_url"),
    ] {
        let cols = db
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !cols.iter().any(|s| s == name) {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} TEXT"))?;
        }
    }
    // Match account history, queue accounting and retention scans without changing rows.
    db.execute_batch("CREATE INDEX IF NOT EXISTS jobs_account_created ON jobs(account,created DESC);
CREATE INDEX IF NOT EXISTS jobs_active_reserved ON jobs(status,reserved) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS images_visible_history ON stored_images(account,created DESC,job DESC,idx DESC) WHERE deleted=0 AND hidden=0;
CREATE INDEX IF NOT EXISTS template_assets_created ON template_assets(created);")?;
    if db
        .query_row(
            "SELECT 1 FROM schema_migrations WHERE name='image-retention-v3'",
            [],
            |r| r.get::<_, i32>(0),
        )
        .optional()?
        .is_none()
    {
        let rows = db
            .prepare("SELECT id,account,created,result FROM jobs")?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (job, account, created, result) in rows {
            let result: Value =
                serde_json::from_str(result.as_deref().unwrap_or("{}")).unwrap_or(json!({}));
            if let Some(images) = result["images"].as_array() {
                for i in images {
                    if let Some(idx) = i["index"].as_i64().filter(|i| (0..4).contains(i)) {
                        db.execute("INSERT OR IGNORE INTO stored_images(job,idx,account,file,type,created) VALUES(?,?,?,?,?,?)",params![job,idx,account,format!("{job}-{idx}"),strv(i,"type"),created])?;
                    }
                }
            }
        }
        db.execute(
            "INSERT INTO schema_migrations(name,created) VALUES('image-retention-v3',?)",
            [now()],
        )?;
    }
    Ok(())
}
pub fn prepare_dirs(data: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o700))?;
    if data.join("state.sqlite").exists() {
        std::fs::set_permissions(
            data.join("state.sqlite"),
            std::fs::Permissions::from_mode(0o600),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_sqlite_migration_and_transaction_rollback() {
        let mut db = Connection::open(":memory:").unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        let columns = db
            .prepare("PRAGMA table_info(author_tasks)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(columns.iter().any(|c| c == "fingerprint"));
        let balance: i64 = db
            .query_row("SELECT balance FROM shared_ledger WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(balance, 50000);
        {
            let tx = db.transaction().unwrap();
            tx.execute("UPDATE shared_ledger SET balance=100 WHERE id=1", [])
                .unwrap();
        }
        assert_eq!(
            db.query_row("SELECT balance FROM shared_ledger WHERE id=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            50000
        );
    }
}
