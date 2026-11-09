use super::video_access;
use crate::*;

async fn public_image_request(client: reqwest::Client, url: url::Url) -> Result<reqwest::Response> {
    tokio::time::timeout(Duration::from_secs(18), async {
        for attempt in 0..2 {
            services::public_figures::outbound_slot().await;
            let response = client
                .get(url.clone())
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|_| Error(502, "公开参考图暂时无法读取".into()))?;
            if matches!(response.status().as_u16(), 429 | 503) {
                let delay = match response.headers().get(header::RETRY_AFTER) {
                    Some(value) => value
                        .to_str()
                        .ok()
                        .and_then(|v| v.parse::<u64>().ok())
                        .filter(|v| *v <= 3),
                    None => Some(1),
                };
                if let Some(seconds) = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                {
                    services::public_figures::cooldown(seconds);
                }
                if attempt == 0 {
                    if let Some(seconds) = delay {
                        drop(response);
                        services::public_figures::cooldown(seconds);
                        continue;
                    }
                }
            }
            return Ok(response);
        }
        unreachable!("the last attempt always returns")
    })
    .await
    .map_err(|_| Error(504, "公开参考图读取超时，请稍后重试".into()))?
}

pub async fn handle(
    a: App,
    path: String,
    method: String,
    url: url::Url,
    h: HeaderMap,
    req: Request<Body>,
    peer: SocketAddr,
) -> Result<Response> {
    if path == "/api/health" && method == "GET" {
        let _: i64 = a
            .db()
            .query_row(repositories::statements::api::HEALTH, [], |r| r.get(0))?;
        return Ok(reply(
            200,
            json!({"ok":true,"runtime":"rust","version":env!("CARGO_PKG_VERSION"),"maintenance":a.config("MAINTENANCE_MODE")=="1","database":if a.database_mode==DatabaseMode::Postgres{"postgres"}else{"sqlite"}}),
        ));
    }
    if a.config("MAINTENANCE_MODE") == "1"
        && (path.starts_with("/api/") || path == "/manage" || path.starts_with("/manage/"))
    {
        return Err(Error(503, "系统维护中，请稍后重试".into()));
    }
    if path == "/api/public-figure-search" && method == "GET" {
        let name = url
            .query_pairs()
            .find(|(key, _)| key == "name")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
        let context = url
            .query_pairs()
            .find(|(key, _)| key == "context")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
        let result = services::public_figures::search(name, context).await?;
        return Ok(reply(
            200,
            serde_json::to_value(result).map_err(|_| Error(500, "人物图片结果编码失败".into()))?,
        ));
    }
    if path == "/api/public-image" && method == "GET" {
        let remote = url
            .query_pairs()
            .find(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
            .ok_or_else(|| fail("图片地址无效"))?;
        let parsed = url::Url::parse(&remote).map_err(|_| fail("图片地址无效"))?;
        if parsed.scheme() != "https"
            || !services::public_figures::approved_image(&parsed)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port().is_some()
            || parsed.fragment().is_some()
        {
            return Err(fail("图片来源未核验或已过期，请重新搜索人物图片"));
        }
        let client = reqwest::Client::builder()
            .user_agent(services::public_figures::USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| Error(502, "公开参考图暂时无法读取".into()))?;
        let response = public_image_request(client, parsed).await?;
        if !response.status().is_success() {
            if response.status().as_u16() == 429 {
                return Err(Error(429, "公开图片暂时繁忙，请稍后重试".into()));
            }
            return Err(Error(502, "公开参考图暂时无法读取".into()));
        }
        let mime = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        if !["image/jpeg", "image/png", "image/webp"].contains(&mime.as_str()) {
            return Err(fail("参考图格式不受支持"));
        }
        if response
            .content_length()
            .is_some_and(|length| length > 4 * 1024 * 1024)
        {
            return Err(Error(413, "参考图必须小于 4 MB".into()));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error(502, "公开参考图读取失败".into()))?;
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(Error(413, "参考图必须小于 4 MB".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(fail("公开参考图为空"));
        }
        return Ok(binary(bytes, &mime));
    }
    if path.starts_with("/api/admin/") || path.starts_with("/manage/") {
        return admin::handle(&a, &path, &method, h, req, peer).await;
    }
    if path == "/api/templates" && method == "GET" {
        return Ok(reply(200, templates::manifest(&a)));
    }
    if path.starts_with("/api/template-assets/") && ["GET", "HEAD"].contains(&method.as_str()) {
        return templates::asset(&a, &path, method == "HEAD");
    }
    if path == "/api/bootstrap" && method == "GET" {
        let db = a.db();
        let existing = cookie(&h, "jianlai_session").and_then(|t| {
            db.query_row(
                repositories::statements::api::SELECT_ACCOUNTS_TOKEN,
                [hash(&t)],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
        });
        let mut set = None;
        let account = if let Some(id) = existing {
            id
        } else {
            let raw = id(32);
            let account = hash(&raw);
            db.execute(
                repositories::statements::api::INSERT_ACCOUNTS,
                params![account, hash(&raw)],
            )?;
            set=Some(format!("jianlai_session={raw}; HttpOnly; SameSite=Strict; Path=/jianlai/; Max-Age=31536000{}",if h.get("x-forwarded-proto").is_some_and(|s|s=="https"){"; Secure"}else{""}));
            account
        };
        let active_video = db.query_row(repositories::statements::api::SELECT_VIDEO_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING_CREATED,[&account],|r|r.get::<_,String>(0)).optional()?;
        let active = db
            .query_row(
                repositories::statements::api::SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING_CREATED,
                params![account, now() - 600000],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        let mut v = store::money(&db)?;
        v["accountId"] = json!(account);
        v["retentionDays"] = json!(store::USER_IMAGE_RETENTION_DAYS);
        v["imagePriceCents"] = json!(30);
        v["videoPriceCentsPerSecond"] = json!(120);
        v["videoMinSeconds"] = json!(4);
        v["videoMaxSeconds"] = json!(15);
        v["videoEnabled"] = json!(true);
        v["videoAccessRequired"] = json!(false);
        v["capabilities"] = store::capabilities();
        v["activeJob"] = active
            .map(|j| store::public_job(&db, &j))
            .transpose()?
            .unwrap_or(Value::Null);
        v["activeVideo"] = active_video
            .map(|j| video_job(&db, &j))
            .transpose()?
            .unwrap_or(Value::Null);
        let mut r = reply(200, v);
        if let Some(s) = set {
            r.headers_mut()
                .insert(header::SET_COOKIE, s.parse().unwrap());
        }
        return Ok(r);
    }
    if path.starts_with("/api/") {
        let account = {
            let db = a.db();
            cookie(&h, "jianlai_session")
                .and_then(|t| {
                    db.query_row(
                        repositories::statements::api::SELECT_ACCOUNTS_TOKEN,
                        [hash(&t)],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                })
                .ok_or_else(|| Error(401, "请刷新页面恢复账户".into()))?
        };
        if !["GET", "HEAD"].contains(&method.as_str()) && !same_origin(&h) {
            return Err(Error(403, "请求来源无效".into()));
        }
        if (path == "/api/videos" || path.starts_with("/api/videos/"))
            && !["GET", "HEAD"].contains(&method.as_str())
        {
            video_access::require_origin(&h)?;
        }
        if let Some(c) = regex::Regex::new(r"^/api/videos/([a-f0-9]{32})/media$")
            .unwrap()
            .captures(&path)
        {
            if ["GET", "HEAD"].contains(&method.as_str()) {
                return video_access::media(&a, &c[1], &account, &h, method == "HEAD").await;
            }
        }
        if path == "/api/history" && method == "GET" {
            return Ok(reply(200, store::history(&a.db(), &account, &url)?));
        }
        if path == "/api/jobs/by-request" && method == "GET" {
            let key = url
                .query_pairs()
                .find(|(key, _)| key == "requestKey")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            if !matches(r"^[a-zA-Z0-9-]{16,80}$", &key) {
                return Err(fail("任务标识无效"));
            }
            let db = a.db();
            let job = db
                .query_row(
                    repositories::statements::submissions::SELECT_JOBS_ACCOUNT,
                    params![account, key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| Error(404, "未找到原请求任务".into()))?;
            return Ok(reply(200, store::public_job(&db, &job)?));
        }
        if path == "/api/chat" && method == "GET" {
            return Ok(reply(200, chat::status(&account)));
        }
        if path == "/api/chat" && method == "POST" {
            let input = body(req).await?;
            if strv(&input, "mode") == "video" {
                video_access::require_origin(&h)?;
            }
            return chat::handle(&a, &account, input).await;
        }
        if path == "/api/videos/by-request" && method == "GET" {
            let key = url
                .query_pairs()
                .find(|(key, _)| key == "requestKey")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            if !matches(r"^[a-zA-Z0-9-]{16,80}$", &key) {
                return Err(fail("任务标识无效"));
            }
            let db = a.db();
            let job = db
                .query_row(
                    repositories::statements::submissions::SELECT_VIDEO_JOBS_ACCOUNT,
                    params![account, key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| Error(404, "任务尚未找到".into()))?;
            return Ok(reply(200, video_job(&db, &job)?));
        }
        if path == "/api/videos" && method == "GET" {
            let rows = a.db().prepare(repositories::statements::api::SELECT_VIDEO_JOBS_ACCOUNT_CREATED_CREATED)?
                .query_map(params![account, now() - 7 * DAY], |r| { let id: String = r.get(0)?; let url = r.get::<_,Option<String>>(8)?.map(|_| format!("api/videos/{id}/media")); Ok(json!({"id":id,"status":r.get::<_,String>(1)?,"phase":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?,"prompt":r.get::<_,String>(4)?,"duration":r.get::<_,i64>(5)?,"ratio":r.get::<_,String>(6)?,"resolution":r.get::<_,String>(7)?,"url":url,"error":r.get::<_,Option<String>>(9)?.unwrap_or_default(),"reservedCents":r.get::<_,i64>(10)?,"chargedCents":r.get::<_,i64>(11)?,"providerId":r.get::<_,Option<String>>(12)?,"started":r.get::<_,Option<i64>>(13)?})) })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(reply(200, json!({"records":rows,"retentionDays":7})));
        }
        if path == "/api/videos" && method == "POST" {
            return services::submissions::video(a, account, body(req).await?).await;
        }
        if let Some(c) = regex::Regex::new(r"^/api/videos/([a-f0-9]{32})$")
            .unwrap()
            .captures(&path)
        {
            if method == "GET" {
                let db = a.db();
                let owned = db
                    .query_row(
                        repositories::statements::api::SELECT_VIDEO_JOBS_ID,
                        [&c[1]],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?;
                if owned.as_deref() != Some(&account) {
                    return Err(Error(404, "视频任务不存在".into()));
                }
                return Ok(reply(200, video_job(&db, &c[1])?));
            }
        }
        if path == "/api/generate" && method == "POST" {
            return services::submissions::image(a, account, body(req).await?).await;
        }
        if let Some(c) = regex::Regex::new(r"^/api/jobs/([a-f0-9]{32})(?:/images/(\d))?$")
            .unwrap()
            .captures(&path)
        {
            let job = &c[1];
            let image = {
                let db = a.db();
                if db
                    .query_row(
                        repositories::statements::api::SELECT_JOBS_ID_ACCOUNT,
                        params![job, account],
                        |r| r.get::<_, i32>(0),
                    )
                    .optional()?
                    .is_none()
                {
                    return Err(Error(404, "任务不存在".into()));
                }
                if let Some(idx) = c.get(2) {
                    let idx: i64 = idx.as_str().parse().unwrap();
                    if method == "DELETE" {
                        db.execute(
                            repositories::statements::api::UPDATE_STORED_IMAGES_JOB_IDX_ACCOUNT,
                            params![job, idx, account],
                        )?;
                        return Ok(reply(200, json!({"ok":true})));
                    }
                    if ["GET", "HEAD"].contains(&method.as_str()) {
                        Some((idx, store::find_image(&db, job, idx, false)?))
                    } else {
                        None
                    }
                } else if method == "GET" {
                    return Ok(reply(200, store::public_job(&db, job)?));
                } else {
                    None
                }
            };
            if c.get(2).is_some() {
                let (_, image) = image.ok_or_else(|| Error(404, "接口不存在".into()))?;
                if let Some(url) = image.object_url.as_deref() {
                    if method == "HEAD" {
                        let response = a
                            .client
                            .head(url)
                            .timeout(Duration::from_secs(30))
                            .send()
                            .await
                            .map_err(|_| Error(502, "OSS图片读取失败".into()))?;
                        if !response.status().is_success() {
                            return Err(Error(410, "OSS图片暂时不可用".into()));
                        }
                        // HEAD has no body; reqwest's decoded body length can be zero.
                        let length = response
                            .headers()
                            .get(header::CONTENT_LENGTH)
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(0);
                        return Ok(binary_head(length, &image.mime));
                    }
                    return Ok(binary(store::oss_read(&a, url).await?, &image.mime));
                }
                let path = store::safe_image(&a, &image)?;
                if method == "HEAD" {
                    let length = std::fs::metadata(&path)
                        .map_err(|_| Error(410, "图片文件已不可用".into()))?
                        .len();
                    return Ok(binary_head(length, &image.mime));
                }
                let bytes =
                    std::fs::read(path).map_err(|_| Error(410, "图片文件已不可用".into()))?;
                return Ok(binary(bytes, &image.mime));
            }
        }
        return Err(Error(404, "接口不存在".into()));
    }
    if !["GET", "HEAD"].contains(&method.as_str()) {
        return Err(Error(405, "方法不支持".into()));
    }
    let file = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    if file
        .split('/')
        .any(|s| s.starts_with('.') || s == "admin" || s == "manage")
        || file.contains('\\')
    {
        return Err(Error(404, "文件不存在".into()));
    }
    let public = a.root.join("public").canonicalize()?;
    let target = public
        .join(file)
        .canonicalize()
        .map_err(|_| Error(404, "文件不存在".into()))?;
    if !target.starts_with(&public) || !target.is_file() {
        return Err(Error(404, "文件不存在".into()));
    }
    let mime = mime_guess::from_path(&target)
        .first_or_octet_stream()
        .to_string();
    if method == "HEAD" {
        let length = std::fs::metadata(&target)?.len();
        return Ok(binary_head(length, &mime));
    }
    let bytes = std::fs::read(&target)?;
    Ok(binary(bytes, &mime))
}
