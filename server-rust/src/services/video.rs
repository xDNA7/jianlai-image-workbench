use crate::*;
use futures_util::StreamExt;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

fn config<'a>(a: &'a App, key: &'a str, fallback: &'a str) -> &'a str {
    let value = a.config(key);
    if value.is_empty() {
        fallback
    } else {
        value
    }
}
fn temp_path(a: &App, name: &str) -> PathBuf {
    let root = std::path::Path::new(a.config("VIDEO_TEMP_DIR"));
    if root.as_os_str().is_empty() {
        std::env::temp_dir().join(name)
    } else {
        root.join(name)
    }
}

async fn update(
    a: &App,
    id: &str,
    status: &str,
    phase: &str,
    url: Option<&str>,
    error: Option<&str>,
    charged: i64,
) -> Result<()> {
    let db = a.db();
    let tx = db.unchecked_transaction()?;
    let (previous, reserved): (String, i64) = tx.query_row(
        repositories::statements::video::SELECT_VIDEO_JOBS_ID,
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !["queued", "running"].contains(&previous.as_str()) {
        return Ok(());
    }
    if status == "done" && (charged < 0 || charged > reserved) {
        return Err(fail("视频预留额度异常"));
    }
    if status == "done"
        && tx.execute(
            repositories::statements::images::UPDATE_SHARED_LEDGER_ID_BALANCE,
            params![charged, charged],
        )? != 1
    {
        return Err(fail("视频额度结算异常"));
    }
    tx.execute(
        repositories::statements::video::UPDATE_VIDEO_JOBS_ID,
        params![
            status,
            phase,
            if status == "done" { charged } else { 0 },
            url,
            error,
            id
        ],
    )?;
    tx.commit()?;
    if let Some(pool) = a.postgres.clone() {
        let balance = a.db().query_row(
            repositories::statements::admin::SELECT_SHARED_LEDGER_ID,
            [],
            |r| r.get::<_, i64>(0),
        );
        if let Ok(balance) = balance {
            tokio::spawn(async move {
                if let Err(error) = pool.set_ledger(balance).await {
                    tracing::error!(code = %crate::middleware::postgres_error_code(&error), "postgres_shadow_ledger_sync_failed");
                }
            });
        }
    }
    if let Some(pool) = a.postgres.clone() {
        let id = id.to_owned();
        let status = status.to_owned();
        let phase = phase.to_owned();
        let url = url.map(str::to_owned);
        let error = error.map(str::to_owned);
        let final_charge = if status == "done" { charged } else { 0 };
        tokio::spawn(async move {
            if let Err(error_value) = pool
                .update_video(
                    &id,
                    &status,
                    &phase,
                    final_charge,
                    url.as_deref(),
                    error.as_deref(),
                )
                .await
            {
                tracing::error!(job = %id, code = %crate::middleware::postgres_error_code(&error_value), "postgres_shadow_video_update_failed");
            }
        });
    }
    Ok(())
}

async fn task(a: &App, provider_id: &str) -> Result<Value> {
    let endpoint = format!(
        "{}/v2/query/video_generation/{}",
        config(a, "VIDEO_API_BASE", "https://ai.huanling.icu").trim_end_matches('/'),
        provider_id
    );
    let response = a
        .client
        .get(endpoint)
        .bearer_auth(config(a, "VIDEO_API_KEY", ""))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| fail("视频任务状态查询失败"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| fail("视频服务响应无法解析"))?;
    if !status.is_success() {
        return Err(fail("视频服务查询失败"));
    }
    Ok(body.get("task").cloned().unwrap_or(body))
}

async fn download_file(a: &App, id: &str, url: &str) -> Result<PathBuf> {
    const MAX_BYTES: u64 = 512 * 1024 * 1024;
    let response = a
        .client
        .get(url)
        .bearer_auth(config(a, "VIDEO_API_KEY", ""))
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|_| fail("视频下载失败"))?;
    if !response.status().is_success() {
        return Err(fail("视频下载失败"));
    }
    if response.content_length().is_some_and(|n| n > MAX_BYTES) {
        return Err(fail("视频文件超过512MB限制"));
    }
    let path = temp_path(a, &format!("jianlai-video-{id}.mp4"));
    let mut file = tokio::fs::File::create(&path).await?;
    let mut stream = response.bytes_stream();
    let mut total = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(v) => v,
            Err(_) => {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err(fail("视频读取失败"));
            }
        };
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(fail("视频文件超过512MB限制"));
        }
        if file.write_all(&chunk).await.is_err() {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(fail("视频暂存失败"));
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    Ok(path)
}

async fn publish(a: &App, id: &str, path: &std::path::Path) -> Result<String> {
    let meta = tokio::fs::metadata(path).await?;
    let mut file = tokio::fs::File::open(path).await?;
    let mut header = [0u8; 16];
    let read = tokio::io::AsyncReadExt::read(&mut file, &mut header).await?;
    if meta.len() < 8
        || read < 16
        || meta.len() > 512 * 1024 * 1024
        || (!header[4..8].eq(b"ftyp") && !header.starts_with(b"\x1a\x45\xdf\xa3"))
    {
        let _ = tokio::fs::remove_file(path).await;
        return Err(fail("视频文件校验失败"));
    }
    let key = format!("results/videos/{id}.mp4");
    let app = a.clone();
    let src = path.to_path_buf();
    let key_copy = key.clone();
    let upload = tokio::task::spawn_blocking(move || {
        store::oss_copy_private(&app, &src, &key_copy, "video/mp4", "private,no-store")
    })
    .await
    .map_err(|_| fail("视频OSS上传任务中断"))?;
    let _ = tokio::fs::remove_file(path).await;
    upload?;
    store::oss_public_url(a, &key).ok_or_else(|| fail("OSS公开地址未配置"))
}

async fn presign(a: &App, key: &str) -> Result<String> {
    let app = a.clone();
    let object = key.to_owned();
    tokio::task::spawn_blocking(move || store::oss_presign(&app, &object, "2h"))
        .await
        .map_err(|_| fail("OSS签名任务中断"))?
}

async fn refund_input(a: &App, id: &str) {
    let (key, account) = a
        .db()
        .query_row(
            repositories::statements::video::SELECT_VIDEO_JOBS_ID_2,
            [id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
        )
        .unwrap_or((None, String::new()));
    if let Some(key) = key {
        let _ = store::oss_remove(a, &key);
        let _ = a.db().execute(
            repositories::statements::video::UPDATE_VIDEO_JOBS_ID_ACCOUNT,
            params![id, account],
        );
    }
}

pub async fn run(a: &App, id: &str) {
    let exists = a.db().query_row(
        repositories::statements::video::SELECT_VIDEO_JOBS_ID_3,
        [id],
        |r| r.get::<_, String>(0),
    );
    if !matches!(exists.as_deref(), Ok("queued" | "running")) {
        return;
    }
    let _ = a.db().execute(
        repositories::statements::video::UPDATE_VIDEO_JOBS_ID_2,
        params![now(), id],
    );
    let row = a.db().query_row(
        repositories::statements::video::SELECT_VIDEO_JOBS_ID_4,
        [id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        },
    );
    let Ok((prompt, duration, ratio, resolution, input_key)) = row else {
        return;
    };
    let existing = a
        .db()
        .query_row(
            repositories::statements::video::SELECT_VIDEO_JOBS_ID_5,
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let provider_id = if let Some(provider_id) = existing {
        provider_id
    } else {
        let image = match input_key.as_deref() {
            Some(key) => match presign(a, key).await {
                Ok(url) => Some(url),
                Err(_) => {
                    let _ = update(
                        a,
                        id,
                        "failed",
                        "failed",
                        None,
                        Some("首帧授权失败，额度已退回"),
                        0,
                    )
                    .await;
                    refund_input(a, id).await;
                    return;
                }
            },
            None => None,
        };
        let mut content = vec![json!({"type":"text","text":prompt})];
        if let Some(ref url) = image {
            content.push(json!({"type":"image_url","image_url":{"url":url},"role":"first_frame"}));
        }
        let body = json!({"model":config(a,"VIDEO_MODEL","MiniMax-H3"),"content":content,"resolution":resolution,"duration":duration,"ratio":if image.is_some(){"adaptive"}else{&ratio}});
        let endpoint = format!(
            "{}/v2/video_generation",
            config(a, "VIDEO_API_BASE", "https://ai.huanling.icu").trim_end_matches('/')
        );
        let response = a
            .client
            .post(endpoint)
            .bearer_auth(config(a, "VIDEO_API_KEY", ""))
            .json(&body)
            .timeout(Duration::from_secs(45))
            .send()
            .await;
        let Ok(response) = response else {
            let _ = update(
                a,
                id,
                "failed",
                "failed",
                None,
                Some("视频服务连接超时，额度已退回"),
                0,
            )
            .await;
            refund_input(a, id).await;
            return;
        };
        let status = response.status();
        let result = response.json::<Value>().await.unwrap_or(json!({}));
        if !status.is_success() {
            let _ = update(
                a,
                id,
                "failed",
                "failed",
                None,
                Some("视频服务拒绝了请求，额度已退回"),
                0,
            )
            .await;
            refund_input(a, id).await;
            return;
        }
        let provider_id = result["task_id"].as_str().unwrap_or("").to_owned();
        if provider_id.is_empty() {
            let _ = update(
                a,
                id,
                "failed",
                "failed",
                None,
                Some("视频服务未返回任务编号，额度已退回"),
                0,
            )
            .await;
            refund_input(a, id).await;
            return;
        }
        let _ = a.db().execute(
            repositories::statements::video::UPDATE_VIDEO_JOBS_ID_3,
            params![provider_id, id],
        );
        provider_id
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(duration as u64 * 60 + 300);
    loop {
        if tokio::time::Instant::now() >= deadline {
            let _ = update(
                a,
                id,
                "failed",
                "failed",
                None,
                Some("视频生成超时，额度已退回"),
                0,
            )
            .await;
            refund_input(a, id).await;
            return;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
        match task(a, &provider_id).await {
            Ok(t)
                if matches!(strv(&t, "status"), "queued" | "running")
                    || matches!(strv(&t, "status"), "Preparing" | "Queueing" | "Processing") =>
            {
                let _ = a.db().execute(
                    repositories::statements::video::UPDATE_VIDEO_JOBS_ID_4,
                    [id],
                );
            }
            Ok(t) if matches!(strv(&t, "status"), "failed" | "cancelled") => {
                let _ = update(
                    a,
                    id,
                    "failed",
                    "failed",
                    None,
                    Some("视频生成失败，额度已退回"),
                    0,
                )
                .await;
                refund_input(a, id).await;
                return;
            }
            Ok(t) if matches!(strv(&t, "status"), "succeeded" | "Success") => {
                let direct = t["content"]["url"]
                    .as_str()
                    .or_else(|| t["video_url"].as_str());
                let url = if let Some(url) = direct {
                    url.to_owned()
                } else if let Some(file_id) = t["file_id"].as_str() {
                    let endpoint = format!(
                        "{}/v1/files/retrieve?file_id={}",
                        config(a, "VIDEO_API_BASE", "https://ai.huanling.icu")
                            .trim_end_matches('/'),
                        file_id
                    );
                    match a
                        .client
                        .get(endpoint)
                        .bearer_auth(config(a, "VIDEO_API_KEY", ""))
                        .timeout(Duration::from_secs(30))
                        .send()
                        .await
                    {
                        Ok(r) if r.status().is_success() => r
                            .json::<Value>()
                            .await
                            .ok()
                            .and_then(|v| v["file"]["download_url"].as_str().map(str::to_owned))
                            .unwrap_or_default(),
                        _ => String::new(),
                    }
                } else {
                    String::new()
                };
                if url.is_empty() {
                    let _ = update(
                        a,
                        id,
                        "failed",
                        "failed",
                        None,
                        Some("视频结果地址缺失，额度已退回"),
                        0,
                    )
                    .await;
                    refund_input(a, id).await;
                    return;
                }
                let path = match download_file(a, id, &url).await {
                    Ok(path) => path,
                    Err(_) => {
                        let _ = update(
                            a,
                            id,
                            "failed",
                            "failed",
                            None,
                            Some("视频下载或校验失败，额度已退回"),
                            0,
                        )
                        .await;
                        refund_input(a, id).await;
                        return;
                    }
                };
                let object = match publish(a, id, &path).await {
                    Ok(u) => u,
                    Err(_) => {
                        let _ = update(
                            a,
                            id,
                            "failed",
                            "failed",
                            None,
                            Some("视频保存至OSS失败，额度已退回"),
                            0,
                        )
                        .await;
                        refund_input(a, id).await;
                        return;
                    }
                };
                let _ = update(a, id, "done", "done", Some(&object), None, duration * 120).await;
                refund_input(a, id).await;
                return;
            }
            _ => {}
        }
    }
}

pub async fn resume(a: &App) -> Result<()> {
    let interrupted: Vec<(String, i64)> = a
        .db()
        .prepare(repositories::statements::video::SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING_PROVIDER_ID_STARTED)?
        .query_map([now()-DAY], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, _reserved) in interrupted {
        // Reservation is an availability hold, never a debit to refund.
        a.db().execute(
            repositories::statements::video::UPDATE_VIDEO_JOBS_ID_5,
            [&id],
        )?;
        refund_input(a, &id).await;
    }
    let active: Vec<String> = a
        .db()
        .prepare(
            repositories::statements::video::SELECT_VIDEO_JOBS_STATUS_RUNNING_PROVIDER_ID_STARTED,
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let a = a.clone();
    // A single feeder uses the same bounded queue and four worker slots as new
    // jobs. Every interrupted task is resumed, including batches above four.
    tokio::spawn(async move {
        for job in active {
            let Ok(permit) = a.admission.clone().acquire_owned().await else {
                break;
            };
            if a.sender
                .send(Work {
                    job,
                    p: json!({}),
                    author: Some(("video".into(), json!({}))),
                    _permit: permit,
                })
                .is_err()
            {
                tracing::error!("video_recovery_queue_closed");
                break;
            }
        }
    });
    Ok(())
}

pub fn cleanup(a: &App) -> Result<()> {
    let old: Vec<(String, Option<String>)> = a
        .db()
        .prepare(
            repositories::statements::video::SELECT_VIDEO_JOBS_STATUS_DONE_FAILED_CREATED_VIDEO_URL,
        )?
        .query_map([now() - 7 * DAY], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, url) in old {
        if let Some(url) = url {
            if let Some(key) = store::oss_key_from_url(a, &url) {
                if let Err(e) = store::oss_remove(a, &key) {
                    tracing::error!(job = id, code = e.0, "video_object_cleanup_failed");
                    continue;
                }
            }
        }
        a.db().execute(
            repositories::statements::video::UPDATE_VIDEO_JOBS_ID_6,
            [id],
        )?;
    }
    Ok(())
}
