//! Storage boundary shared by the legacy business services. PostgreSQL uses
//! SQLx exclusively; SQLite is selected explicitly for rollback releases.
//! All SQL inputs are bound values. The small dialect mapper only rewrites
//! application-owned statement text, never request data.
use rusqlite::types::{FromSql, ToSql, ToSqlOutput, Value, ValueRef};
pub use rusqlite::{params, OptionalExtension};
use sqlx::{Column, Executor, PgPool, Row as SqlxRow, TypeInfo, ValueRef as SqlxValueRef};
use std::{
    borrow::Cow,
    collections::HashMap,
    future::Future,
    sync::{LazyLock, Mutex},
    time::Duration,
};
type Result<T> = rusqlite::Result<T>;

fn pg_error(e: sqlx::Error) -> rusqlite::Error {
    // Do not print SQL, bind values, URLs, or provider credentials.
    tracing::error!(
        code = e
            .as_database_error()
            .and_then(|e| e.code())
            .as_deref()
            .unwrap_or("transport"),
        "postgres_repository_failed"
    );
    rusqlite::Error::InvalidQuery
}
fn wait<T>(f: impl Future<Output = std::result::Result<T, sqlx::Error>>) -> Result<T> {
    // These legacy services are synchronous between network awaits. Let Tokio
    // replace this worker before blocking; never nest Runtime::block_on on a
    // runtime worker. PostgreSQL transactions contain DB operations only.
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(f)).map_err(pg_error)
}

pub trait BindParams {
    fn values(self) -> Result<Vec<Value>>;
}
fn owned(v: &dyn ToSql) -> Result<Value> {
    match v.to_sql()? {
        ToSqlOutput::Borrowed(v) => Ok(v.into()),
        ToSqlOutput::Owned(v) => Ok(v),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
impl BindParams for [(); 0] {
    fn values(self) -> Result<Vec<Value>> {
        Ok(vec![])
    }
}
impl<T: ToSql> BindParams for [T; 1] {
    fn values(self) -> Result<Vec<Value>> {
        self.iter().map(|v| owned(v)).collect()
    }
}
impl<T: ToSql> BindParams for [T; 2] {
    fn values(self) -> Result<Vec<Value>> {
        self.iter().map(|v| owned(v)).collect()
    }
}
impl BindParams for &[&dyn ToSql] {
    fn values(self) -> Result<Vec<Value>> {
        self.iter().map(|v| owned(*v)).collect()
    }
}
impl<const N: usize> BindParams for &[&dyn ToSql; N] {
    fn values(self) -> Result<Vec<Value>> {
        self.iter().map(|v| owned(*v)).collect()
    }
}

pub enum Connection {
    Sqlite(rusqlite::Connection),
    Postgres(PgPool),
    Transaction(Mutex<Option<sqlx::Transaction<'static, sqlx::Postgres>>>),
}
impl Connection {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        rusqlite::Connection::open(path).map(Self::Sqlite)
    }
    pub fn from_pool(pool: PgPool) -> Self {
        Self::Postgres(pool)
    }
    pub fn busy_timeout(&self, timeout: Duration) -> Result<()> {
        match self {
            Self::Sqlite(c) => c.busy_timeout(timeout),
            _ => Ok(()),
        }
    }
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        match self {
            Self::Sqlite(c) => c.execute_batch(sql),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
    pub fn execute(&self, sql: &str, params: impl BindParams) -> Result<usize> {
        let values = params.values()?;
        match self {
            Self::Sqlite(c) => c.execute(sql, rusqlite::params_from_iter(values)),
            _ => self.pg_query(sql, values, false).map(|(_, n)| n as usize),
        }
    }
    pub fn query_row<T>(
        &self,
        sql: &str,
        params: impl BindParams,
        f: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        let values = params.values()?;
        match self {
            Self::Sqlite(c) => c.query_row(sql, rusqlite::params_from_iter(values), |r| {
                f(&Row::Sqlite(r))
            }),
            _ => {
                let (rows, _) = self.pg_query(sql, values, true)?;
                rows.first()
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)
                    .and_then(|r| f(&Row::Postgres(r)))
            }
        }
    }
    pub fn prepare<'a>(&'a self, sql: &str) -> Result<Statement<'a>> {
        Ok(Statement {
            connection: self,
            sql: sql.to_owned(),
        })
    }
    pub fn transaction_with_behavior(
        &mut self,
        behavior: rusqlite::TransactionBehavior,
    ) -> Result<Transaction<'_>> {
        match self {
            Self::Sqlite(c) => Ok(Transaction {
                inner: TransactionInner::Sqlite(c.transaction_with_behavior(behavior)?),
            }),
            _ => self.unchecked_transaction(),
        }
    }
    pub fn transaction(&mut self) -> Result<Transaction<'_>> {
        self.unchecked_transaction()
    }
    pub fn unchecked_transaction(&self) -> Result<Transaction<'_>> {
        match self {
            Self::Sqlite(c) => Ok(Transaction {
                inner: TransactionInner::Sqlite(c.unchecked_transaction()?),
            }),
            Self::Postgres(pool) => {
                let mut c = wait(pool.begin())?;
                wait(
                    sqlx::query("SELECT balance FROM shared_ledger WHERE id=1 FOR UPDATE")
                        .fetch_one(&mut *c),
                )?;
                Ok(Transaction {
                    inner: TransactionInner::Postgres(Connection::Transaction(Mutex::new(Some(c)))),
                })
            }
            Self::Transaction(_) => Err(rusqlite::Error::InvalidQuery),
        }
    }
    fn pg_query(
        &self,
        sql: &str,
        values: Vec<Value>,
        rows: bool,
    ) -> Result<(Vec<sqlx::postgres::PgRow>, u64)> {
        let sql = dialect(sql);
        match self {
            Self::Postgres(pool) => wait(async {
                let mut c = pool.acquire().await?;
                query(&mut c, &sql, values, rows).await
            }),
            Self::Transaction(c) => {
                let mut c = c.lock().unwrap_or_else(|e| e.into_inner());
                wait(query(
                    c.as_mut().ok_or(rusqlite::Error::InvalidQuery)?,
                    &sql,
                    values,
                    rows,
                ))
            }
            _ => unreachable!(),
        }
    }
}

pub struct Transaction<'a> {
    inner: TransactionInner<'a>,
}
enum TransactionInner<'a> {
    Sqlite(rusqlite::Transaction<'a>),
    Postgres(Connection),
}
impl Transaction<'_> {
    pub fn execute(&self, sql: &str, p: impl BindParams) -> Result<usize> {
        match &self.inner {
            TransactionInner::Sqlite(t) => t.execute(sql, rusqlite::params_from_iter(p.values()?)),
            TransactionInner::Postgres(c) => c.execute(sql, p),
        }
    }
    pub fn query_row<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        match &self.inner {
            TransactionInner::Sqlite(t) => {
                t.query_row(sql, rusqlite::params_from_iter(p.values()?), |r| {
                    f(&Row::Sqlite(r))
                })
            }
            TransactionInner::Postgres(c) => c.query_row(sql, p, f),
        }
    }
    pub fn commit(self) -> Result<()> {
        match self.inner {
            TransactionInner::Sqlite(t) => t.commit(),
            TransactionInner::Postgres(Connection::Transaction(c)) => wait(
                c.into_inner()
                    .unwrap_or_else(|e| e.into_inner())
                    .ok_or(rusqlite::Error::InvalidQuery)?
                    .commit(),
            ),
            _ => unreachable!(),
        }
    }
}
// SQLx Transaction::drop queues rollback on its connection, including cancellation
// and early-return paths, without requiring an active Tokio handle in Drop.

pub trait Query {
    fn query_row<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T>;
    fn query_all<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnMut(&Row<'_>) -> Result<T>,
    ) -> Result<Vec<T>>;
}
impl Query for Connection {
    fn query_row<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        Connection::query_row(self, sql, p, f)
    }
    fn query_all<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnMut(&Row<'_>) -> Result<T>,
    ) -> Result<Vec<T>> {
        self.prepare(sql)?.query_map(p, f)?.collect()
    }
}
impl Query for Transaction<'_> {
    fn query_row<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        Transaction::query_row(self, sql, p, f)
    }
    fn query_all<T>(
        &self,
        sql: &str,
        p: impl BindParams,
        mut f: impl FnMut(&Row<'_>) -> Result<T>,
    ) -> Result<Vec<T>> {
        match &self.inner {
            TransactionInner::Sqlite(t) => t
                .prepare(sql)?
                .query_map(rusqlite::params_from_iter(p.values()?), |r| {
                    f(&Row::Sqlite(r))
                })?
                .collect(),
            TransactionInner::Postgres(c) => c.query_all(sql, p, f),
        }
    }
}
impl<T: Query> Query for std::sync::MutexGuard<'_, T> {
    fn query_row<R>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnOnce(&Row<'_>) -> Result<R>,
    ) -> Result<R> {
        (**self).query_row(sql, p, f)
    }
    fn query_all<R>(
        &self,
        sql: &str,
        p: impl BindParams,
        f: impl FnMut(&Row<'_>) -> Result<R>,
    ) -> Result<Vec<R>> {
        (**self).query_all(sql, p, f)
    }
}

pub struct Statement<'a> {
    connection: &'a Connection,
    sql: String,
}
impl Statement<'_> {
    pub fn query_map<T>(
        &mut self,
        p: impl BindParams,
        mut f: impl FnMut(&Row<'_>) -> Result<T>,
    ) -> Result<std::vec::IntoIter<Result<T>>> {
        let p = p.values()?;
        let result = match self.connection {
            Connection::Sqlite(c) => c
                .prepare(&self.sql)?
                .query_map(rusqlite::params_from_iter(p), |r| f(&Row::Sqlite(r)))?
                .collect::<Vec<_>>(),
            _ => self
                .connection
                .pg_query(&self.sql, p, true)?
                .0
                .iter()
                .map(|r| f(&Row::Postgres(r)))
                .collect(),
        };
        Ok(result.into_iter())
    }
}
pub enum Row<'a> {
    Sqlite(&'a rusqlite::Row<'a>),
    Postgres(&'a sqlx::postgres::PgRow),
}
pub trait Index {
    fn sqlite(&self, r: &rusqlite::Row<'_>) -> Result<usize>;
    fn pg(&self, r: &sqlx::postgres::PgRow) -> Result<usize>;
}
impl Index for usize {
    fn sqlite(&self, _: &rusqlite::Row<'_>) -> Result<usize> {
        Ok(*self)
    }
    fn pg(&self, _: &sqlx::postgres::PgRow) -> Result<usize> {
        Ok(*self)
    }
}
impl Index for &str {
    fn sqlite(&self, r: &rusqlite::Row<'_>) -> Result<usize> {
        r.as_ref().column_index(self)
    }
    fn pg(&self, r: &sqlx::postgres::PgRow) -> Result<usize> {
        let name = column(self);
        r.columns()
            .iter()
            .position(|c| c.name() == name)
            .ok_or_else(|| rusqlite::Error::InvalidColumnName(self.to_string()))
    }
}
impl Row<'_> {
    pub fn get<I: Index, T: FromSql>(&self, i: I) -> Result<T> {
        match self {
            Self::Sqlite(r) => r.get(i.sqlite(r)?),
            Self::Postgres(r) => {
                let idx = i.pg(r)?;
                let raw = r.try_get_raw(idx).map_err(pg_error)?;
                let v = if raw.is_null() {
                    Value::Null
                } else {
                    match raw.type_info().name() {
                        "BOOL" => {
                            Value::Integer(i64::from(r.try_get::<bool, _>(idx).map_err(pg_error)?))
                        }
                        "INT2" => {
                            Value::Integer(i64::from(r.try_get::<i16, _>(idx).map_err(pg_error)?))
                        }
                        "INT4" => {
                            Value::Integer(i64::from(r.try_get::<i32, _>(idx).map_err(pg_error)?))
                        }
                        "INT8" => Value::Integer(r.try_get(idx).map_err(pg_error)?),
                        "JSON" | "JSONB" => Value::Text(
                            r.try_get::<serde_json::Value, _>(idx)
                                .map_err(pg_error)?
                                .to_string(),
                        ),
                        _ => Value::Text(r.try_get(idx).map_err(pg_error)?),
                    }
                };
                T::column_result(ValueRef::from(&v)).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        idx,
                        ValueRef::from(&v).data_type(),
                        Box::new(e),
                    )
                })
            }
        }
    }
}
fn column(s: &str) -> &str {
    match s {
        "type" => "mime",
        "requestKey" => "request_key",
        "templateId" => "template_id",
        "jobId" => "job_id",
        "assetId" => "asset_id",
        _ => s,
    }
}
static COLUMN_TOKENS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b(requestKey|templateId|jobId|assetId|type)\b").unwrap());
static BOOLEAN_VALUES: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b(hidden|deleted|used)\s*=\s*([01])\b").unwrap());
static INTEGER_SUM: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"COALESCE\(SUM\(([^)]+)\),0\)").unwrap());
static POSTGRES_STATEMENTS: LazyLock<HashMap<&'static str, String>> = LazyLock::new(|| {
    crate::repositories::statements::ALL
        .iter()
        .map(|&sql| (sql, translate_dialect(sql)))
        .collect()
});

fn dialect(sql: &str) -> Cow<'static, str> {
    // Only the fixed application catalog is cached; arbitrary SQL cannot grow it.
    match POSTGRES_STATEMENTS.get(sql) {
        Some(translated) => Cow::Borrowed(translated),
        None => Cow::Owned(translate_dialect(sql)),
    }
}

fn translate_dialect(sql: &str) -> String {
    fn rewrite(s: &str, index: &mut usize) -> String {
        let mut out = COLUMN_TOKENS
            .replace_all(s, |c: &regex::Captures<'_>| column(&c[0]).to_string())
            .to_string();
        out = BOOLEAN_VALUES
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("{}={}", &c[1], if &c[2] == "1" { "TRUE" } else { "FALSE" })
            })
            .to_string();
        out = INTEGER_SUM
            .replace_all(&out, "COALESCE(SUM($1),0)::bigint")
            .to_string();
        out.chars()
            .map(|c| {
                if c == '?' {
                    *index += 1;
                    format!("${index}")
                } else {
                    c.to_string()
                }
            })
            .collect()
    }
    let ignore = sql.starts_with("INSERT OR IGNORE ");
    let sql = if ignore {
        sql.replacen("INSERT OR IGNORE ", "INSERT ", 1)
    } else {
        sql.to_owned()
    };
    let mut out = String::new();
    let mut plain = String::new();
    let mut quoted = false;
    let mut index = 0;
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    out.push(chars.next().unwrap());
                } else {
                    quoted = false;
                }
            }
        } else if c == '\'' {
            out.push_str(&rewrite(&plain, &mut index));
            plain.clear();
            out.push(c);
            quoted = true;
        } else {
            plain.push(c);
        }
    }
    out.push_str(&rewrite(&plain, &mut index));
    if ignore {
        out.push_str(" ON CONFLICT DO NOTHING");
    }
    out
}

async fn query(
    c: &mut sqlx::PgConnection,
    sql: &str,
    values: Vec<Value>,
    rows: bool,
) -> std::result::Result<(Vec<sqlx::postgres::PgRow>, u64), sqlx::Error> {
    let described = c.describe(sql).await?;
    let types = described.parameters().and_then(|p| p.left());
    let mut q = sqlx::query(sql);
    for (i, v) in values.into_iter().enumerate() {
        let ty = types
            .and_then(|t| t.get(i))
            .map(|t| t.name())
            .unwrap_or("TEXT");
        q = match v {
            Value::Null => match ty {
                "INT2" => q.bind(None::<i16>),
                "INT4" => q.bind(None::<i32>),
                "INT8" => q.bind(None::<i64>),
                "BOOL" => q.bind(None::<bool>),
                "JSONB" | "JSON" => q.bind(None::<serde_json::Value>),
                _ => q.bind(None::<String>),
            },
            Value::Integer(v) => match ty {
                "INT2" => q.bind(i16::try_from(v).map_err(|e| sqlx::Error::Encode(Box::new(e)))?),
                "INT4" => q.bind(i32::try_from(v).map_err(|e| sqlx::Error::Encode(Box::new(e)))?),
                "BOOL" => q.bind(v != 0),
                _ => q.bind(v),
            },
            Value::Text(v) => match ty {
                "JSONB" | "JSON" => q.bind(
                    serde_json::from_str::<serde_json::Value>(&v)
                        .map_err(|e| sqlx::Error::Decode(Box::new(e)))?,
                ),
                _ => q.bind(v),
            },
            Value::Real(v) => q.bind(v),
            Value::Blob(v) => q.bind(v),
        };
    }
    if rows {
        Ok((q.fetch_all(c).await?, 0))
    } else {
        Ok((vec![], q.execute(c).await?.rows_affected()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires isolated jianlai_test_ database"]
    async fn postgres_statement_catalog() {
        let url = std::env::var("JIANLAI_TEST_DATABASE_URL").expect("isolated test URL required");
        let pool = PgPool::connect(&url).await.unwrap();
        let database: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            database.starts_with("jianlai_test_"),
            "refusing non-test database"
        );
        for &sql in crate::repositories::statements::ALL {
            let result = pool.describe(&dialect(sql)).await;
            assert!(
                result.is_ok(),
                "statement failed to prepare: {sql}: {result:?}"
            );
        }
    }
    #[test]
    fn maps_only_application_identifiers_and_placeholders() {
        assert_eq!(dialect("SELECT type,requestKey FROM stored_images WHERE hidden=0 AND job=? AND file='type? it''s used=1'"),"SELECT mime,request_key FROM stored_images WHERE hidden=FALSE AND job=$1 AND file='type? it''s used=1'");
        assert_eq!(
            dialect("INSERT OR IGNORE INTO jobs(id,requestKey) VALUES(?,?)"),
            "INSERT INTO jobs(id,request_key) VALUES($1,$2) ON CONFLICT DO NOTHING"
        );
        assert_eq!(dialect("SELECT COALESCE(SUM(reserved),0) FROM jobs WHERE status IN ('queued','running')"),"SELECT COALESCE(SUM(reserved),0)::bigint FROM jobs WHERE status IN ('queued','running')");
    }

    #[test]
    fn catalog_translations_are_borrowed_and_unknown_statements_are_not_cached() {
        for &sql in crate::repositories::statements::ALL {
            let translated = dialect(sql);
            assert!(matches!(translated, Cow::Borrowed(_)));
            assert_eq!(translated, translate_dialect(sql));
        }
        let cached = POSTGRES_STATEMENTS.len();
        for id in 0..10 {
            let sql = format!("SELECT {id},requestKey FROM jobs WHERE id=?");
            assert!(matches!(dialect(&sql), Cow::Owned(_)));
        }
        assert_eq!(POSTGRES_STATEMENTS.len(), cached);
    }

    #[test]
    fn placeholders_and_booleans_skip_escaped_sql_literals() {
        assert_eq!(
            dialect("SELECT 'it''s ? hidden=0 requestKey',requestKey FROM jobs WHERE id=? AND status='?' AND hidden=1 AND deleted = 0 AND used=1 AND jobId=?"),
            "SELECT 'it''s ? hidden=0 requestKey',request_key FROM jobs WHERE id=$1 AND status='?' AND hidden=TRUE AND deleted=FALSE AND used=TRUE AND job_id=$2"
        );
        assert_eq!(
            dialect("INSERT OR IGNORE INTO jobs(id,requestKey) VALUES(?,'requestKey ?')"),
            "INSERT INTO jobs(id,request_key) VALUES($1,'requestKey ?') ON CONFLICT DO NOTHING"
        );
    }
}
