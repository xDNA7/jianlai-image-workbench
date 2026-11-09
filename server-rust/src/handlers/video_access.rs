//! Account-owned video delivery and mandatory Origin checks for writes.
use crate::*;

pub fn require_origin(h: &HeaderMap) -> Result<()> {
    if h.contains_key(header::ORIGIN) && same_origin(h) {
        Ok(())
    } else {
        Err(Error(403, "请求来源无效".into()))
    }
}

// Proxy private media without exposing storage URLs; account ownership applies to GET/HEAD/Range.
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
        let (sender, _) = mpsc::unbounded_channel();
        App(Arc::new(Inner {
            db: Mutex::new(db),
            data: PathBuf::new(),
            root: PathBuf::new(),
            env: HashMap::new(),
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
        origin: Option<&str>,
        authenticated: bool,
    ) -> Result<Response> {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "example.test".parse().unwrap());
        if let Some(origin) = origin {
            h.insert(header::ORIGIN, origin.parse().unwrap());
        }
        if authenticated {
            h.insert(
                header::COOKIE,
                "jianlai_session=account-token".parse().unwrap(),
            );
        }
        super::super::api::handle(
            a.clone(),
            path.into(),
            method.into(),
            url::Url::parse(&format!("https://example.test{path}")).unwrap(),
            h,
            Request::new(Body::from(if path == "/api/chat" {
                "{\"mode\":\"video\",\"messages\":[]}"
            } else {
                "{}"
            })),
            "127.0.0.1:1234".parse().unwrap(),
        )
        .await
    }
    async fn value(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn public_video_uses_ordinary_account_without_internal_login() {
        let a = test_app();
        let bootstrap = value(call(&a, "/api/bootstrap", "GET", None, true).await.unwrap()).await;
        assert_eq!(bootstrap["videoEnabled"], true);
        assert_eq!(bootstrap["videoAccessRequired"], false);
        assert_eq!(bootstrap["activeVideo"]["id"], "b".repeat(32));
        let list = value(call(&a, "/api/videos", "GET", None, true).await.unwrap())
            .await
            .to_string();
        assert!(list.contains("api/videos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/media"));
        assert!(!list.contains("private.example"));
        assert_eq!(
            call(&a, "/api/videos", "GET", None, false)
                .await
                .unwrap_err()
                .0,
            401
        );
        assert!(call(&a, "/api/history", "GET", None, true).await.is_ok());
        assert_eq!(
            call(&a, "/api/video-access", "GET", None, true)
                .await
                .unwrap_err()
                .0,
            404
        );
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn video_writes_still_require_same_origin_and_media_stays_account_scoped() {
        let a = test_app();
        for path in [
            "/api/videos",
            "/api/chat",
            "/api/videos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/retry",
        ] {
            for origin in [None, Some("https://foreign.test")] {
                assert_eq!(
                    call(&a, path, "POST", origin, true).await.unwrap_err().0,
                    403
                );
            }
        }
        assert_eq!(
            media(
                &a,
                &"a".repeat(32),
                "other-account",
                &HeaderMap::new(),
                false
            )
            .await
            .unwrap_err()
            .0,
            404
        );
    }
    #[test]
    fn video_origin_is_mandatory() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "example.test".parse().unwrap());
        assert!(require_origin(&h).is_err());
        h.insert(header::ORIGIN, "https://example.test".parse().unwrap());
        assert!(require_origin(&h).is_ok());
        h.insert(header::ORIGIN, "https://other.test".parse().unwrap());
        assert!(require_origin(&h).is_err());
    }
}
