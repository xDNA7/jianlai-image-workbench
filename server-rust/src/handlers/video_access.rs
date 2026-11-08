//! Independent internal-video access. Sessions are opaque, account-bound and
//! memory-only: restart or credential rotation requires users to sign in again.
use crate::*;
use std::sync::OnceLock;
use subtle::ConstantTimeEq;

const COOKIE: &str = "jianlai_video_session";
const SESSION_MS: i64 = 8 * 60 * 60 * 1000;
const MAX_SESSIONS: usize = 1024;

struct Session {
    account: String,
    credential: String,
    expires: i64,
}
#[derive(Default)]
struct Sessions(HashMap<String, Session>);
impl Sessions {
    fn insert(&mut self, token: &str, account: &str, credential: &str, time: i64) -> Result<i64> {
        self.0.retain(|_, session| session.expires > time);
        if self.0.len() >= MAX_SESSIONS {
            return Err(Error(503, "视频登录暂时繁忙，请稍后再试".into()));
        }
        let expires = time + SESSION_MS;
        self.0.insert(
            hash(token),
            Session {
                account: account.into(),
                credential: credential.into(),
                expires,
            },
        );
        Ok(expires)
    }
    fn expires(&self, token: &str, account: &str, credential: &str, time: i64) -> Option<i64> {
        self.0
            .get(&hash(token))
            .filter(|session| {
                session.account == account
                    && session.credential == credential
                    && session.expires > time
            })
            .map(|session| session.expires)
    }
    fn remove(&mut self, token: &str) {
        self.0.remove(&hash(token));
    }
}
fn sessions() -> &'static Mutex<Sessions> {
    static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(Sessions::default()))
}
fn valid_config(password_hash: &str, salt: &str) -> bool {
    matches("^[a-fA-F0-9]{128}$", password_hash) && salt.len() >= 16
}
pub fn enabled(a: &App) -> bool {
    valid_config(
        a.config("VIDEO_ACCESS_PASSWORD_HASH"),
        a.config("VIDEO_ACCESS_PASSWORD_SALT"),
    )
}
fn credential(a: &App) -> String {
    hash(&format!(
        "{}:{}",
        a.config("VIDEO_ACCESS_PASSWORD_HASH"),
        a.config("VIDEO_ACCESS_PASSWORD_SALT")
    ))
}
pub fn expires(a: &App, h: &HeaderMap, account: &str) -> Option<i64> {
    if !enabled(a) {
        return None;
    }
    let token = cookie(h, COOKIE)?;
    if !matches("^[a-f0-9]{64}$", &token) {
        return None;
    }
    sessions()
        .lock()
        .unwrap()
        .expires(&token, account, &credential(a), now())
}
pub fn require(a: &App, h: &HeaderMap, account: &str) -> Result<()> {
    expires(a, h, account)
        .map(|_| ())
        .ok_or_else(|| Error(401, "请先验证视频内部访问口令".into()))
}
// Origin is mandatory for all video writes, including sign-in and sign-out.
// Together with SameSite=Strict this also rejects form and absent-Origin CSRF.
pub fn require_origin(h: &HeaderMap) -> Result<()> {
    if h.contains_key(header::ORIGIN) && same_origin(h) {
        Ok(())
    } else {
        Err(Error(403, "请求来源无效".into()))
    }
}
// The production loopback proxy overwrites X-Real-IP. Never trust forwarded
// headers from direct external peers, nor the appendable X-Forwarded-For list.
fn client_ip(h: &HeaderMap, peer: SocketAddr) -> std::net::IpAddr {
    if peer.ip().is_loopback() {
        if let Some(ip) = h
            .get("x-real-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
        {
            return ip;
        }
    }
    peer.ip()
}
fn password_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(2))
}
fn set_cookie(token: &str, seconds: i64) -> String {
    format!("{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={seconds}; Secure")
}
fn state(a: &App, h: &HeaderMap, account: &str) -> Value {
    let expires = expires(a, h, account);
    json!({"authenticated":expires.is_some(),"expiresAt":expires,"enabled":enabled(a)})
}
fn verify_password(password: &[u8], salt: &[u8], expected: &[u8]) -> bool {
    let mut candidate = [0; 64];
    !password.is_empty()
        && password.len() <= 2048
        && expected.len() == 64
        && scrypt::scrypt(
            password,
            salt,
            &scrypt::Params::new(14, 8, 1, 64).unwrap(),
            &mut candidate,
        )
        .is_ok()
        && bool::from(candidate.ct_eq(expected))
}
pub async fn handle(
    a: &App,
    h: &HeaderMap,
    account: &str,
    method: &str,
    req: Request<Body>,
    peer: SocketAddr,
) -> Result<Response> {
    if method == "GET" {
        return Ok(reply(200, state(a, h, account)));
    }
    require_origin(h)?;
    if method == "DELETE" {
        if let Some(token) = cookie(h, COOKIE) {
            sessions().lock().unwrap().remove(&token);
        }
        let mut response = reply(
            200,
            json!({"authenticated":false,"expiresAt":null,"enabled":enabled(a)}),
        );
        response
            .headers_mut()
            .insert(header::SET_COOKIE, set_cookie("", 0).parse().unwrap());
        return Ok(response);
    }
    if method != "POST" {
        return Err(Error(405, "方法不支持".into()));
    }
    if !enabled(a) {
        return Err(Error(503, "视频内部访问尚未配置".into()));
    }
    let key = format!("video:{}:{account}", client_ip(h, peer));
    // Reserve before parsing or scrypt, so concurrent guesses cannot bypass the cap.
    {
        let mut failures = a.failures.lock().unwrap();
        failures.retain(|_, (_, until)| *until > now());
        if failures.get(&key).is_some_and(|(count, _)| *count >= 5) {
            return Err(Error(429, "登录失败过多，请稍后再试".into()));
        }
        if failures.len() >= 10000 && !failures.contains_key(&key) {
            return Err(Error(429, "登录请求过多，请稍后再试".into()));
        }
        let entry = failures.entry(key.clone()).or_insert((0, now() + 900000));
        entry.0 += 1;
    }
    let _password_slot = password_slots()
        .try_acquire()
        .map_err(|_| Error(429, "视频登录请求繁忙，请稍后再试".into()))?;
    let bytes = tokio::time::timeout(Duration::from_secs(10), to_bytes(req.into_body(), 4096))
        .await
        .map_err(|_| Error(408, "请求超时".into()))?
        .map_err(|_| Error(413, "请求内容过大".into()))?;
    let input: Value = serde_json::from_slice(&bytes).map_err(|_| fail("JSON请求格式无效"))?;
    let password = strv(&input, "password").to_owned();
    let salt = a.config("VIDEO_ACCESS_PASSWORD_SALT").to_owned();
    let expected = hex::decode(a.config("VIDEO_ACCESS_PASSWORD_HASH")).unwrap();
    let valid = tokio::task::spawn_blocking(move || {
        verify_password(password.as_bytes(), salt.as_bytes(), &expected)
    })
    .await
    .unwrap_or(false);
    if !valid {
        return Err(Error(401, "视频访问口令错误".into()));
    }
    a.failures.lock().unwrap().remove(&key);
    let token = id(32);
    let expires = {
        let mut sessions = sessions().lock().unwrap();
        if let Some(old) = cookie(h, COOKIE) {
            sessions.remove(&old);
        }
        sessions.insert(&token, account, &credential(a), now())?
    };
    let mut response = reply(
        200,
        json!({"authenticated":true,"expiresAt":expires,"enabled":true}),
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        set_cookie(&token, SESSION_MS / 1000).parse().unwrap(),
    );
    Ok(response)
}

/// No storage or signed URL is exposed to browsers; both Range and HEAD requests
/// remain subject to internal access and ordinary account ownership checks.
pub async fn media(
    a: &App,
    job: &str,
    account: &str,
    h: &HeaderMap,
    head: bool,
) -> Result<Response> {
    let stored: Option<String> = a
        .db()
        .query_row(
            "SELECT video_url FROM video_jobs WHERE id=? AND account=? AND status='done'",
            params![job, account],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let stored = stored.ok_or_else(|| Error(404, "视频文件不存在".into()))?;
    let key = store::oss_key_from_url(a, &stored)
        .filter(|key| key == &format!("results/videos/{job}.mp4"))
        .ok_or_else(|| Error(410, "视频文件地址不可用".into()))?;
    let app = a.clone();
    let signed = tokio::task::spawn_blocking(move || store::oss_presign(&app, &key, "5m"))
        .await
        .map_err(|_| Error(502, "视频读取失败".into()))??;
    // OSS presign authorizes GET specifically. For a browser HEAD, issue GET
    // upstream, copy headers and drop its body without buffering video bytes.
    let mut request = a.client.get(signed).timeout(Duration::from_secs(120));
    if let Some(range) = h.get(header::RANGE) {
        request = request.header(header::RANGE, range);
    }
    if let Some(range) = h.get(header::IF_RANGE) {
        request = request.header(header::IF_RANGE, range);
    }
    let upstream = request
        .send()
        .await
        .map_err(|_| Error(502, "视频读取失败".into()))?;
    if !upstream.status().is_success() && upstream.status().as_u16() != 416 {
        return Err(Error(502, "视频文件暂时不可用".into()));
    }
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::new(if head {
        Body::empty()
    } else {
        Body::from_stream(upstream.bytes_stream())
    });
    *response.status_mut() = status;
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = headers.get(&name) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("inline; filename=\"{job}.mp4\"").parse().unwrap(),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_serial() -> &'static tokio::sync::Mutex<()> {
        static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
    }
    fn test_app() -> App {
        let db = Connection::Sqlite(rusqlite::Connection::open_in_memory().unwrap());
        store::migrate(&db).unwrap();
        db.execute(
            "INSERT INTO accounts(id,token) VALUES(?,?)",
            params!["owner", hash("account-token")],
        )
        .unwrap();
        db.execute("INSERT INTO video_jobs(id,account,requestKey,fingerprint,status,phase,created,prompt,duration,ratio,resolution,video_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", params!["a".repeat(32), "owner", "test-request-key-123", "fingerprint", "done", "done", now(), "private video prompt", 10, "16:9", "768P", "https://private.example/results/videos/test.mp4"]).unwrap();
        db.execute("INSERT INTO video_jobs(id,account,requestKey,fingerprint,status,phase,created,prompt,duration,ratio,resolution) VALUES(?,?,?,?,?,?,?,?,?,?,?)", params!["b".repeat(32), "owner", "test-request-key-456", "fingerprint", "queued", "queued", now(), "private running prompt", 10, "16:9", "768P"]).unwrap();
        let salt = "test-salt-at-least-16";
        let mut expected = [0; 64];
        scrypt::scrypt(
            b"internal-test-password",
            salt.as_bytes(),
            &scrypt::Params::new(14, 8, 1, 64).unwrap(),
            &mut expected,
        )
        .unwrap();
        let (sender, _) = mpsc::unbounded_channel();
        App(Arc::new(Inner {
            db: Mutex::new(db),
            data: PathBuf::new(),
            root: PathBuf::new(),
            env: HashMap::from([
                ("VIDEO_ACCESS_PASSWORD_HASH".into(), hex::encode(expected)),
                ("VIDEO_ACCESS_PASSWORD_SALT".into(), salt.into()),
            ]),
            client: reqwest::Client::new(),
            admission: Arc::new(Semaphore::new(4)),
            slots: Arc::new(Semaphore::new(4)),
            video_slots: Arc::new(Semaphore::new(4)),
            sender,
            manifest: Mutex::new(json!({"templates":[]})),
            failures: Mutex::new(HashMap::new()),
            queue_wait: 1000,
            postgres: None,
            database_mode: DatabaseMode::Sqlite,
        }))
    }
    async fn call(
        a: &App,
        path: &str,
        method: &str,
        video_cookie: Option<&str>,
        input: Value,
    ) -> Result<Response> {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "example.test".parse().unwrap());
        h.insert(header::ORIGIN, "https://example.test".parse().unwrap());
        h.insert(
            header::COOKIE,
            format!(
                "jianlai_session=account-token{}",
                video_cookie.map(|s| format!("; {s}")).unwrap_or_default()
            )
            .parse()
            .unwrap(),
        );
        super::super::api::handle(
            a.clone(),
            path.into(),
            method.into(),
            url::Url::parse(&format!("https://example.test{path}")).unwrap(),
            h,
            Request::new(Body::from(input.to_string())),
            "127.0.0.1:1234".parse().unwrap(),
        )
        .await
    }
    async fn value(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn http_access_protects_video_and_preserves_public_images() {
        let _guard = test_serial().lock().await;
        let a = test_app();
        let bootstrap = value(
            call(&a, "/api/bootstrap", "GET", None, Value::Null)
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(bootstrap["activeVideo"], Value::Null);
        assert_eq!(bootstrap["videoEnabled"], false);
        assert_eq!(
            call(&a, "/api/videos", "GET", None, Value::Null)
                .await
                .unwrap_err()
                .0,
            401
        );
        assert_eq!(
            call(
                &a,
                &format!("/api/videos/{}/media", "a".repeat(32)),
                "HEAD",
                None,
                Value::Null
            )
            .await
            .unwrap_err()
            .0,
            401
        );
        assert_eq!(
            call(
                &a,
                "/api/chat",
                "POST",
                None,
                json!({"mode":"video","messages":[]})
            )
            .await
            .unwrap_err()
            .0,
            401
        );
        assert!(call(&a, "/api/history", "GET", None, Value::Null)
            .await
            .is_ok());
        let logged = call(
            &a,
            "/api/video-access",
            "POST",
            None,
            json!({"password":"internal-test-password"}),
        )
        .await
        .unwrap();
        let cookie = logged
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        assert_eq!(value(logged).await["authenticated"], true);
        let list = value(
            call(&a, "/api/videos", "GET", Some(&cookie), Value::Null)
                .await
                .unwrap(),
        )
        .await;
        let serialized = list.to_string();
        assert!(serialized.contains("api/videos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/media"));
        assert!(!serialized.contains("private.example"));
        let bootstrap = value(
            call(&a, "/api/bootstrap", "GET", Some(&cookie), Value::Null)
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(bootstrap["videoEnabled"], true);
        assert_eq!(bootstrap["activeVideo"]["id"], "b".repeat(32));
        let balance = store::money(&a.db()).unwrap();
        call(
            &a,
            "/api/video-access",
            "DELETE",
            Some(&cookie),
            Value::Null,
        )
        .await
        .unwrap();
        assert_eq!(
            call(&a, "/api/videos", "GET", Some(&cookie), Value::Null)
                .await
                .unwrap_err()
                .0,
            401
        );
        assert_eq!(store::money(&a.db()).unwrap(), balance);
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn http_login_failure_limit_is_separate_and_does_not_charge() {
        let _guard = test_serial().lock().await;
        let a = test_app();
        let balance = store::money(&a.db()).unwrap();
        for _ in 0..5 {
            assert_eq!(
                call(
                    &a,
                    "/api/video-access",
                    "POST",
                    None,
                    json!({"password":"wrong"})
                )
                .await
                .unwrap_err()
                .0,
                401
            );
        }
        assert_eq!(
            call(
                &a,
                "/api/video-access",
                "POST",
                None,
                json!({"password":"internal-test-password"})
            )
            .await
            .unwrap_err()
            .0,
            429
        );
        assert_eq!(store::money(&a.db()).unwrap(), balance);
        assert!(a
            .failures
            .lock()
            .unwrap()
            .contains_key("video:127.0.0.1:owner"));
    }
    #[test]
    fn trusted_proxy_ip_is_strict_and_external_headers_are_ignored() {
        let proxy: SocketAddr = "127.0.0.1:3218".parse().unwrap();
        let external: SocketAddr = "198.51.100.8:1234".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", "203.0.113.1".parse().unwrap());
        h.insert("x-forwarded-for", "203.0.113.99".parse().unwrap());
        assert_eq!(client_ip(&h, proxy).to_string(), "203.0.113.1");
        assert_eq!(client_ip(&h, external), external.ip());
        h.insert("x-real-ip", "malformed, 203.0.113.2".parse().unwrap());
        assert_eq!(client_ip(&h, proxy), proxy.ip());
        h.remove("x-real-ip");
        assert_eq!(client_ip(&h, proxy), proxy.ip());
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn separate_proxy_clients_and_accounts_do_not_share_failure_lock() {
        let _guard = test_serial().lock().await;
        let a = test_app();
        let peer: SocketAddr = "127.0.0.1:3218".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "example.test".parse().unwrap());
        h.insert(header::ORIGIN, "https://example.test".parse().unwrap());
        h.insert("x-real-ip", "203.0.113.1".parse().unwrap());
        a.failures
            .lock()
            .unwrap()
            .insert("video:203.0.113.1:owner".into(), (5, now() + 900000));
        let request = || {
            Request::new(Body::from(
                json!({"password":"internal-test-password"}).to_string(),
            ))
        };
        assert_eq!(
            handle(&a, &h, "owner", "POST", request(), peer)
                .await
                .unwrap_err()
                .0,
            429
        );
        h.insert("x-real-ip", "203.0.113.2".parse().unwrap());
        assert_eq!(
            handle(&a, &h, "owner", "POST", request(), peer)
                .await
                .unwrap()
                .status(),
            200
        );
        h.insert("x-real-ip", "203.0.113.1".parse().unwrap());
        assert_eq!(
            handle(&a, &h, "second-account", "POST", request(), peer)
                .await
                .unwrap()
                .status(),
            200
        );
    }
    #[test]
    fn sessions_bind_account_expire_rotate_and_revoke() {
        let mut sessions = Sessions::default();
        let expires = sessions
            .insert("opaque-token", "account", "credential", 100)
            .unwrap();
        assert!(sessions
            .expires("opaque-token", "account", "credential", 101)
            .is_some());
        assert!(sessions
            .expires("different", "account", "credential", 101)
            .is_none());
        assert!(sessions
            .expires("opaque-token", "other", "credential", 101)
            .is_none());
        assert!(sessions
            .expires("opaque-token", "account", "rotated", 101)
            .is_none());
        assert!(sessions
            .expires("opaque-token", "account", "credential", expires)
            .is_none());
        assert!(!sessions.0.contains_key("opaque-token"));
        sessions.remove("opaque-token");
        assert!(sessions
            .expires("opaque-token", "account", "credential", 101)
            .is_none());
    }
    #[test]
    fn credentials_fail_closed_and_writes_require_origin() {
        assert!(!valid_config("", ""));
        assert!(!valid_config(&"a".repeat(128), "short"));
        assert!(!valid_config(&"z".repeat(128), &"s".repeat(16)));
        assert!(valid_config(&"a".repeat(128), &"s".repeat(16)));
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "example.test".parse().unwrap());
        assert!(require_origin(&h).is_err());
        h.insert(header::ORIGIN, "https://example.test".parse().unwrap());
        assert!(require_origin(&h).is_ok());
        h.insert(header::ORIGIN, "https://other.test".parse().unwrap());
        assert!(require_origin(&h).is_err());
        assert!(set_cookie("test", 10)
            .contains("HttpOnly; SameSite=Strict; Path=/; Max-Age=10; Secure"));
    }
    #[test]
    fn scrypt_verification_rejects_wrong_and_oversized_passwords() {
        let salt = b"test-salt-at-least-16";
        let mut expected = [0; 64];
        scrypt::scrypt(
            b"internal-test-password",
            salt,
            &scrypt::Params::new(14, 8, 1, 64).unwrap(),
            &mut expected,
        )
        .unwrap();
        assert!(verify_password(b"internal-test-password", salt, &expected));
        assert!(!verify_password(b"wrong-password", salt, &expected));
        assert!(!verify_password(&vec![b'x'; 2049], salt, &expected));
        assert!(!verify_password(b"", salt, &expected));
    }
}
