use crate::*;

pub async fn video(a: App, account: String, input: Value) -> Result<Response> {
    if a.config("VIDEO_API_KEY").is_empty() {
        return Err(Error(503, "视频服务尚未配置".into()));
    }

    let key = strv(&input, "requestKey").to_owned();
    let prompt = strv(&input, "prompt").trim().to_owned();
    let duration = input["duration"].as_i64().unwrap_or(0);
    let ratio = strv(&input, "ratio");
    let resolution = strv(&input, "resolution");
    let image_data = strv(&input, "image");
    if !matches(r"^[a-zA-Z0-9-]{16,80}$", &key) {
        return Err(fail("任务标识无效"));
    }
    if prompt.is_empty() || prompt.chars().count() > 2000 {
        return Err(fail("请填写视频描述（最多2000字）"));
    }
    if !(4..=15).contains(&duration) {
        return Err(fail("视频时长须为4至15秒"));
    }
    if !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].contains(&ratio) {
        return Err(fail("画幅无效"));
    }
    if !["768P", "2K"].contains(&resolution) {
        return Err(fail("分辨率无效"));
    }
    if resolution == "2K" && image_data.is_empty() {
        return Err(fail("文生视频暂不支持2K分辨率"));
    }
    let input_bytes = if image_data.is_empty() {
        None
    } else {
        let (bytes, _) = decode_image(image_data, 20 * 1024 * 1024)?;
        let dimensions = image::load_from_memory(&bytes).map_err(|_| fail("首帧图片无效"))?;
        let image_ratio = dimensions.width() as f64 / dimensions.height() as f64;
        if dimensions.width() < 256
            || dimensions.height() < 256
            || !(0.4..=2.5).contains(&image_ratio)
        {
            return Err(fail("首帧图片尺寸或比例不符合视频要求"));
        }
        let mut png = std::io::Cursor::new(Vec::new());
        dimensions
            .to_rgba8()
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|_| fail("首帧图片转换失败"))?;
        Some(png.into_inner())
    };
    let cost = duration * 120;
    let image_hash = image_data
        .rsplit_once(',')
        .map(|(_, v)| hash(v))
        .unwrap_or_default();
    let fingerprint = hash(&serde_json::to_string(&json!({"prompt":prompt,"duration":duration,"ratio":ratio,"resolution":resolution,"image":image_hash})).unwrap());
    let mut db = a.db();
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some((job, fp)) = tx
        .query_row(
            repositories::statements::submissions::SELECT_VIDEO_JOBS_ACCOUNT,
            params![account, key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if fp != fingerprint {
            return Err(Error(409, "相同任务编号对应不同参数".into()));
        }
        return Ok(reply(200, video_job(&tx, &job)?));
    }
    if tx
        .query_row(
            repositories::statements::submissions::SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING,
            params![account, account],
            |r| r.get::<_, i32>(0),
        )
        .optional()?
        .is_some()
    {
        return Err(Error(409, "已有任务生成中，请等待完成".into()));
    }
    let queued: i64 = tx.query_row(
        repositories::statements::submissions::SELECT_VIDEO_JOBS_STATUS_QUEUED,
        [],
        |r| r.get(0),
    )?;
    if queued >= a.slots.available_permits() as i64 + 4 {
        return Err(Error(503, "视频任务排队人数已满，请稍后重试".into()));
    }
    let permit = a
        .admission
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error(503, "生成队列已满，请稍后重试".into()))?;
    let balance: i64 = tx.query_row(
        repositories::statements::admin::SELECT_SHARED_LEDGER_ID,
        [],
        |r| r.get(0),
    )?;
    let image_reserved: i64 = tx.query_row(
        repositories::statements::images::SELECT_JOBS_STATUS_QUEUED_RUNNING,
        [],
        |r| r.get(0),
    )?;
    let video_reserved: i64 = tx.query_row(
        repositories::statements::images::SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING,
        [],
        |r| r.get(0),
    )?;
    if balance - image_reserved - video_reserved < cost {
        return Err(Error(402, "余额不足；视频价格为 ¥1.20/秒".into()));
    }
    let job = id(16);
    let input_key = input_bytes
        .as_ref()
        .map(|_| format!("videos/inputs/{job}.png"));
    tx.execute(
        repositories::statements::submissions::INSERT_VIDEO_JOBS,
        params![
            job,
            account,
            key,
            fingerprint,
            now(),
            cost,
            prompt,
            duration,
            ratio,
            resolution,
            input_key
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
        let shadow_job = job.clone();
        let shadow_account = account.clone();
        let shadow_key = key.clone();
        let shadow_fingerprint = fingerprint.clone();
        let shadow_prompt = prompt.clone();
        let shadow_ratio = ratio.to_owned();
        let shadow_resolution = resolution.to_owned();
        let shadow_input_key = input_key.clone();
        tokio::spawn(async move {
            if let Err(error) = pool
                .insert_video(
                    &shadow_job,
                    &shadow_account,
                    &shadow_key,
                    &shadow_fingerprint,
                    now(),
                    cost,
                    &shadow_prompt,
                    duration,
                    &shadow_ratio,
                    &shadow_resolution,
                    shadow_input_key.as_deref(),
                )
                .await
            {
                tracing::error!(job = %shadow_job, code = %crate::middleware::postgres_error_code(&error), "postgres_shadow_video_write_failed");
            }
        });
    }
    if let Some(bytes) = input_bytes {
        let object_key = format!("videos/inputs/{job}.png");
        let temp_root = std::path::PathBuf::from(a.config("VIDEO_TEMP_DIR"));
        let local = if temp_root.as_os_str().is_empty() {
            std::env::temp_dir()
        } else {
            temp_root
        }
        .join(format!("jianlai-video-input-{job}.png"));
        let uploaded = store::atomic_write(&local, &bytes).and_then(|_| {
            store::oss_copy_private(&a, &local, &object_key, "image/png", "private,max-age=3600")
        });
        let _ = std::fs::remove_file(&local);
        if let Err(error) = uploaded {
            let _ = store::oss_remove(&a, &object_key);
            let _ = db.execute(
                repositories::statements::submissions::UPDATE_VIDEO_JOBS_ID,
                [&job],
            );
            return Err(error);
        }
    }
    if a.sender
        .send(Work {
            job: job.clone(),
            p: json!({}),
            author: Some(("video".into(), json!({}))),
            _permit: permit,
        })
        .is_err()
    {
        db.execute(
            repositories::statements::submissions::UPDATE_VIDEO_JOBS_ID_2,
            [&job],
        )?;
        return Err(Error(503, "任务调度失败，请重试".into()));
    }
    let v = video_job(&db, &job)?;
    Ok(reply(202, v))
}

pub async fn image(a: App, account: String, input: Value) -> Result<Response> {
    let key = strv(&input, "requestKey").to_owned();
    if !matches(r"^[a-zA-Z0-9-]{16,80}$", &key) {
        return Err(fail("任务标识无效"));
    }
    let p = valid_params(input)?;
    let fingerprint = hash(&serde_json::to_string(&p).unwrap());
    let mut db = a.db();
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some((job, fp)) = tx
        .query_row(
            repositories::statements::submissions::SELECT_JOBS_ACCOUNT,
            params![account, key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?
    {
        if fp.is_some_and(|f| f != fingerprint) {
            return Err(Error(409, "相同任务编号对应不同参数".into()));
        }
        let v = store::public_job(&tx, &job)?;
        return Ok(reply(200, v));
    }
    if tx
        .query_row(
            repositories::statements::submissions::SELECT_JOBS_ACCOUNT_STATUS_QUEUED_RUNNING,
            params![account, account],
            |r| r.get::<_, i32>(0),
        )
        .optional()?
        .is_some()
    {
        return Err(Error(409, "已有任务生成中，请等待完成".into()));
    }
    let permit = a
        .admission
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error(503, "生成队列已满，请稍后重试".into()))?;
    let cents = p["count"].as_i64().unwrap() * 30;
    if store::money(&tx)?["availableCents"].as_i64().unwrap() < cents {
        return Err(Error(402, "剩余额度不足，请联系管理员".into()));
    }
    let job = id(16);
    let mut stored = p.clone();
    stored["references"] = json!([]);
    stored["mask"] = json!("");
    tx.execute(
        repositories::statements::submissions::INSERT_JOBS,
        params![
            job,
            account,
            key,
            now(),
            stored.to_string(),
            cents,
            fingerprint
        ],
    )?;
    tx.commit()?;
    drop(db);
    if let Some(pool) = a.postgres.clone() {
        let shadow_job = job.clone();
        let shadow_account = account.clone();
        let shadow_key = key.clone();
        let shadow_params = stored.clone();
        let shadow_fingerprint = fingerprint.clone();
        tokio::spawn(async move {
            if let Err(error) = pool
                .insert_job(
                    &shadow_job,
                    &shadow_account,
                    &shadow_key,
                    now(),
                    &shadow_params,
                    cents,
                    &shadow_fingerprint,
                )
                .await
            {
                tracing::error!(job = %shadow_job, code = %crate::middleware::postgres_error_code(&error), "postgres_shadow_job_write_failed");
            }
        });
    }
    let db = a.db();
    if a.sender
        .send(Work {
            job: job.clone(),
            p,
            author: None,
            _permit: permit,
        })
        .is_err()
    {
        db.execute(
            repositories::statements::submissions::UPDATE_JOBS_ID,
            params![json!({"error":"任务调度失败，未扣费"}).to_string(), job],
        )?;
        return Err(Error(503, "任务调度失败，请重试".into()));
    }
    Ok(reply(202, store::public_job(&db, &job)?))
}
