mod handlers;
mod middleware;
mod routes;
mod services;
use handlers::admin;
use repositories::shadow as pg;
use services::{chat, images as store, templates, upstream, video};
pub mod repositories;

use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use futures_util::StreamExt;
use rand::RngCore;
use repositories::database::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};

pub const DAY: i64 = 86_400_000;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
pub fn id(bytes: usize) -> String {
    let mut b = vec![0; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}
pub fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
pub fn matches(re: &str, s: &str) -> bool {
    regex::Regex::new(re).unwrap().is_match(s)
}
pub fn strv<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn cookie(h: &HeaderMap, key: &str) -> Option<String> {
    h.get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|s| {
            let (k, v) = s.trim().split_once('=')?;
            (k == key).then(|| v.to_owned())
        })
}
pub fn same_origin(h: &HeaderMap) -> bool {
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) != Some("cross-site")
        && h.get(header::ORIGIN)
            .map(|o| {
                o == format!("http://{host}").as_str() || o == format!("https://{host}").as_str()
            })
            .unwrap_or(true)
}
#[derive(Debug)]
pub struct Error(pub u16, pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.1)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub fn fail(msg: &str) -> Error {
    Error(400, msg.into())
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Error(500, "数据处理失败，请稍后重试".into())
    }
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Error(500, "数据处理失败，请稍后重试".into())
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Error(500, "文件处理失败，请稍后重试".into())
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        reply(self.0, json!({"error":self.1}))
    }
}
pub fn reply(status: u16, v: Value) -> Response {
    let mut r = (StatusCode::from_u16(status).unwrap(), axum::Json(v)).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    r
}
pub fn binary(bytes: Vec<u8>, mime: &str) -> Response {
    let length = bytes.len();
    let mut r = Response::new(Body::from(bytes));
    r.headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().unwrap());
    r.headers_mut()
        .insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    r.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    r
}
pub fn binary_head(length: u64, mime: &str) -> Response {
    let mut r = Response::new(Body::empty());
    r.headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().unwrap());
    r.headers_mut()
        .insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    r.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    r
}
pub async fn body(req: Request<Body>) -> Result<Value> {
    let bytes = to_bytes(req.into_body(), 32 * 1024 * 1024)
        .await
        .map_err(|_| Error(413, "请求内容过大".into()))?;
    serde_json::from_slice(&bytes).map_err(|_| fail("JSON请求格式无效"))
}
#[derive(Clone)]
pub struct App(Arc<Inner>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseMode {
    Sqlite,
    Postgres,
}
pub struct Inner {
    pub db: Mutex<Connection>,
    pub data: PathBuf,
    pub root: PathBuf,
    pub env: HashMap<String, String>,
    pub client: reqwest::Client,
    pub admission: Arc<Semaphore>,
    pub slots: Arc<Semaphore>,
    pub video_slots: Arc<Semaphore>,
    pub sender: mpsc::UnboundedSender<Work>,
    pub manifest: Mutex<Value>,
    pub failures: Mutex<HashMap<String, (u32, i64)>>,
    pub queue_wait: i64,
    pub postgres: Option<pg::PostgresShadowRepository>,
    pub database_mode: DatabaseMode,
}
impl std::ops::Deref for App {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}
pub struct Work {
    pub job: String,
    pub p: Value,
    pub author: Option<(String, Value)>,
    pub _permit: OwnedSemaphorePermit,
}
impl App {
    pub fn config(&self, key: &str) -> &str {
        self.env.get(key).map(String::as_str).unwrap_or("")
    }
    pub fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        // Lock contention must also yield the Tokio worker: blocking on the
        // mutex before entering the SQLx bridge can otherwise starve the I/O
        // driver under concurrent HTTP requests and maintenance work.
        tokio::task::block_in_place(|| self.db.lock().unwrap_or_else(|e| e.into_inner()))
    }
}
fn load_env(
    file: &std::path::Path,
    env: &mut HashMap<String, String>,
    optional: bool,
) -> std::io::Result<()> {
    match std::fs::read_to_string(file) {
        Ok(s) => {
            for l in s.lines().filter(|l| !l.trim_start().starts_with('#')) {
                if let Some((k, v)) = l.split_once('=') {
                    env.insert(k.trim().into(), v.into());
                }
            }
            Ok(())
        }
        Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    middleware::init_logging();
    let config = std::env::var("CONFIG_FILE").unwrap_or("/etc/jianlai-studio.env".into());
    let mut env = HashMap::new();
    load_env(std::path::Path::new(&config), &mut env, false)?;
    load_env(
        std::path::Path::new(
            &std::env::var("VISION_CONFIG_FILE").unwrap_or("/etc/jianlai-studio-vision.env".into()),
        ),
        &mut env,
        true,
    )?;
    if config == "/etc/jianlai-studio.env" {
        let video_config = std::env::var("VIDEO_CONFIG_FILE")
            .unwrap_or_else(|_| "/etc/jianlai-studio-video.env".into());
        load_env(std::path::Path::new(&video_config), &mut env, true)?;
    }
    let fallback = std::env::var("IMAGE_FALLBACK_CONFIG_FILE").unwrap_or_else(|_| {
        if config == "/etc/jianlai-studio.env" {
            "/etc/jianlai-studio-fallback.env".into()
        } else {
            String::new()
        }
    });
    if !fallback.is_empty() {
        load_env(std::path::Path::new(&fallback), &mut env, true)?;
    }
    let database_mode = match env
        .get("DATABASE_MODE")
        .map(String::as_str)
        .unwrap_or("sqlite")
    {
        "sqlite" => DatabaseMode::Sqlite,
        "postgres" => {
            if env
                .get("DATABASE_URL")
                .is_none_or(|value| value.trim().is_empty())
            {
                return Err("DATABASE_MODE=postgres requires DATABASE_URL".into());
            }
            DatabaseMode::Postgres
        }
        _ => return Err("DATABASE_MODE must be sqlite or postgres".into()),
    };
    let data = PathBuf::from(
        std::env::var("DATA_DIR")
            .unwrap_or_else(|_| env.get("DATA_DIR").cloned().unwrap_or("./data".into())),
    );
    std::fs::create_dir_all(&data)?;
    let data = std::fs::canonicalize(data)?;
    let video_temp = data.join("video-tmp");
    std::fs::create_dir_all(&video_temp)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&video_temp, std::fs::Permissions::from_mode(0o700))?;
    }
    env.entry("VIDEO_TEMP_DIR".into())
        .or_insert_with(|| video_temp.to_string_lossy().into_owned());
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data.join("rust-server.lock"))?;
    lock.try_lock_exclusive()?;
    let root = std::fs::canonicalize(std::env::var("APP_ROOT").unwrap_or("../app".into()))?;
    let connected_postgres = pg::connect_optional(
        env.get("DATABASE_URL").map(String::as_str),
        database_mode == DatabaseMode::Postgres,
    )
    .await?;
    let db = if database_mode == DatabaseMode::Sqlite {
        let db = Connection::open(data.join("state.sqlite"))?;
        store::migrate(&db)?;
        db
    } else {
        // PostgreSQL mode never creates or opens a SQLite database.
        Connection::from_pool(
            connected_postgres
                .as_ref()
                .expect("validated PostgreSQL URL")
                .pool(),
        )
    };
    store::prepare_dirs(&data)?;
    let mut manifest = if data.join("templates.json").exists() {
        serde_json::from_slice(&std::fs::read(data.join("templates.json"))?)?
    } else {
        json!({"templates":serde_json::from_slice::<Value>(&std::fs::read(root.join("public/templates.json"))?)?,"updatedAt":now()})
    };
    if manifest.is_array() {
        manifest = json!({"templates":manifest,"updatedAt":now()});
    }
    if !manifest["templates"].is_array() {
        return Err("Invalid template manifest".into());
    }
    if data.join("deleted-templates.json").exists() {
        let deleted: Vec<String> =
            serde_json::from_slice(&std::fs::read(data.join("deleted-templates.json"))?)?;
        manifest["templates"]
            .as_array_mut()
            .unwrap()
            .retain(|t| !deleted.iter().any(|id| t["id"] == *id));
    }
    store::atomic_write(
        &data.join("templates.json"),
        manifest.to_string().as_bytes(),
    )?;
    let limit = env
        .get("GENERATION_QUEUE_LIMIT")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(16)
        .clamp(1, 1000);
    let wait = env
        .get("QUEUE_MAX_WAIT_MS")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(900000)
        .max(1);
    let (sender, mut receiver) = mpsc::unbounded_channel::<Work>();
    if connected_postgres.is_some() {
        connected_postgres
            .as_ref()
            .expect("postgres repository exists")
            .health()
            .await?;
    }
    if connected_postgres.is_some() {
        tracing::info!(
            mode = if database_mode == DatabaseMode::Postgres {
                "primary"
            } else {
                "shadow"
            },
            "postgres_ready"
        );
    }
    let postgres = (database_mode == DatabaseMode::Sqlite)
        .then_some(connected_postgres)
        .flatten();
    let app = App(Arc::new(Inner {
        db: Mutex::new(db),
        data,
        root,
        env,
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()?,
        admission: Arc::new(Semaphore::new(4 + limit)),
        slots: Arc::new(Semaphore::new(4)),
        video_slots: Arc::new(Semaphore::new(4)),
        sender,
        manifest: Mutex::new(manifest),
        failures: Mutex::new(HashMap::new()),
        queue_wait: wait,
        postgres,
        database_mode,
    }));
    if app.config("MAINTENANCE_MODE") != "1" {
        store::recover(&app)?;
        video::resume(&app).await?;
        store::cleanup(&app)?;
        video::cleanup(&app)?;
    }
    if app.config("MAINTENANCE_MODE") != "1" {
        let worker = app.clone();
        tokio::spawn(async move {
            while let Some(work) = receiver.recv().await {
                let a = worker.clone();
                tokio::spawn(async move {
                    let _admission = work._permit;
                    let created = {
                        let db = a.db();
                        if let Some((task, _)) = &work.author {
                            if task == "video" {
                                db.query_row(
                                    repositories::statements::main::SELECT_VIDEO_JOBS_ID,
                                    [&work.job],
                                    |r| r.get::<_, i64>(0),
                                )
                                .unwrap_or(0)
                            } else {
                                db.query_row(
                                    repositories::statements::main::SELECT_AUTHOR_TASKS_ID,
                                    [task],
                                    |r| r.get::<_, i64>(0),
                                )
                                .unwrap_or(0)
                            }
                        } else {
                            db.query_row(
                                repositories::statements::main::SELECT_JOBS_ID,
                                [&work.job],
                                |r| r.get::<_, i64>(0),
                            )
                            .unwrap_or(0)
                        }
                    };
                    let video_work = work
                        .author
                        .as_ref()
                        .is_some_and(|(task, _)| task == "video");
                    let recovering_video = video_work
                        && a.db()
                            .query_row(
                                repositories::statements::main::SELECT_VIDEO_STATE,
                                [&work.job],
                                |r| r.get::<_, String>(0),
                            )
                            .is_ok_and(|status| status == "running");
                    let semaphore = if video_work {
                        a.video_slots.clone()
                    } else {
                        a.slots.clone()
                    };
                    let slot = if recovering_video {
                        semaphore.acquire_owned().await.ok()
                    } else {
                        tokio::time::timeout(
                            Duration::from_millis((created + a.queue_wait - now()).max(1) as u64),
                            semaphore.acquire_owned(),
                        )
                        .await
                        .ok()
                        .and_then(std::result::Result::ok)
                    };
                    let Some(_slot) = slot else {
                        let _ = store::expire_queued(&a);
                        if let Some((task, _)) = &work.author {
                            if task == "video" {
                                let _=a.db().execute(repositories::statements::main::UPDATE_VIDEO_JOBS_ID_STATUS_QUEUED,[&work.job]);
                            } else {
                                let _=a.db().execute(repositories::statements::main::UPDATE_AUTHOR_TASKS_ID_STATUS_RUNNING,params![now(),task]);
                            }
                        }
                        return;
                    };
                    if let Some((task, input)) = &work.author {
                        if task == "video" {
                            video::run(&a, &work.job).await;
                            return;
                        }
                        templates::run_author(&a, task, input, &work.job).await;
                    } else {
                        store::execute(&a, &work.job, work.p).await;
                    }
                });
            }
        });
        let maintenance = app.clone();
        tokio::spawn(async move {
            let reaper_ms = maintenance
                .config("REAPER_INTERVAL_MS")
                .parse::<u64>()
                .unwrap_or(1000)
                .max(10);
            let cleanup_ms = maintenance
                .config("CLEANUP_INTERVAL_MS")
                .parse::<i64>()
                .unwrap_or(3600000)
                .max(250);
            let mut interval =
                tokio::time::interval(Duration::from_millis(reaper_ms.min(cleanup_ms as u64)));
            let mut last_cleanup = now();
            let mut last_reconcile = now();
            loop {
                interval.tick().await;
                if let Err(e) = store::expire_queued(&maintenance) {
                    tracing::error!(code = e.0, "queue_expiry_failed");
                }
                if now() - last_reconcile >= 60000 {
                    last_reconcile = now();
                    if let Err(e) = store::reconcile(&maintenance, false) {
                        tracing::error!(code = e.0, "reconcile_failed");
                    }
                }
                if now() - last_cleanup >= cleanup_ms {
                    last_cleanup = now();
                    if let Err(e) = store::cleanup(&maintenance) {
                        tracing::error!(code = e.0, "cleanup_failed");
                    }
                    if let Err(e) = video::cleanup(&maintenance) {
                        tracing::error!(code = e.0, "video_cleanup_failed");
                    }
                }
            }
        });
    }
    let port = std::env::var("PORT")
        .ok()
        .or_else(|| app.env.get("PORT").cloned())
        .unwrap_or("3218".into());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    tracing::info!(
        port = listener.local_addr()?.port(),
        runtime = "rust",
        "jianlai_ready"
    );
    let router = routes::router(app.clone());
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    drop(lock);
    Ok(())
}
pub use services::generation::{decode_image, valid_params, video_job};

#[cfg(test)]
mod public_image_tests {
    fn allowed_public_image_url(raw: &str) -> bool {
        url::Url::parse(raw).ok().is_some_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("upload.wikimedia.org")
                && url.username().is_empty()
                && url.password().is_none()
        })
    }

    #[test]
    fn public_image_proxy_only_allows_wikimedia_https() {
        assert!(allowed_public_image_url(
            "https://upload.wikimedia.org/wikipedia/commons/a.jpg"
        ));
        assert!(!allowed_public_image_url(
            "http://upload.wikimedia.org/a.jpg"
        ));
        assert!(!allowed_public_image_url("https://example.com/a.jpg"));
        assert!(!allowed_public_image_url("https://127.0.0.1/a.jpg"));
        assert!(!allowed_public_image_url(
            "https://user@upload.wikimedia.org/a.jpg"
        ));
    }
}
