#![allow(clippy::items_after_test_module)]

use crate::repositories::database::Row;
use crate::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use image::ImageReader;
use std::{
    fs::{File, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
pub const SIZES: [&str; 9] = [
    "auto",
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "1536x864",
    "864x1536",
    "1365x1024",
    "1024x1365",
    "864x1872",
];
pub const USER_IMAGE_RETENTION_DAYS: i64 = 14;
pub const USER_IMAGE_RETENTION_MS: i64 = USER_IMAGE_RETENTION_DAYS * DAY;

pub const QUALITIES: [&str; 4] = ["auto", "low", "medium", "high"];
pub fn capabilities() -> Value {
    json!({"sizes":SIZES.iter().zip(["自动画幅","1:1 · 方形","3:2 · 横版","2:3 · 竖版","16:9 · 横屏","9:16 · 手机竖屏","4:3 · 横版","3:4 · 竖版","9:19.5 · 手机长屏"]).map(|(v,l)|json!({"value":v,"label":l})).collect::<Vec<_>>(),"qualities":QUALITIES.iter().zip(["自动质量","标准","精细","高质量"]).map(|(v,l)|json!({"value":v,"label":l})).collect::<Vec<_>>(),"count":1,"price":30,"editCount":1,"editPrice":30,"unitPrice":30})
}
pub use crate::repositories::sqlite::{migrate, prepare_dirs};

pub fn money(db: &impl repositories::database::Query) -> Result<Value> {
    let balance: i64 = db.query_row(
        repositories::statements::admin::SELECT_SHARED_LEDGER_ID,
        [],
        |r| r.get(0),
    )?;
    let image_reserved: i64 = db.query_row(
        repositories::statements::images::SELECT_JOBS_STATUS_QUEUED_RUNNING,
        [],
        |r| r.get(0),
    )?;
    let video_reserved: i64 = db
        .query_row(
            repositories::statements::images::SELECT_VIDEO_JOBS_STATUS_QUEUED_RUNNING,
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let reserved = image_reserved + video_reserved;
    Ok(
        json!({"balance":balance as f64/100.,"reserved":reserved as f64/100.,"available":(balance-reserved) as f64/100.,"balanceCents":balance,"reservedCents":reserved,"availableCents":balance-reserved}),
    )
}
#[derive(Clone, Debug)]
pub struct StoredImage {
    pub job: String,
    pub idx: i64,
    pub account: String,
    pub file: String,
    pub mime: String,
    pub object_url: Option<String>,
    pub preview_url: Option<String>,
    pub created: i64,
    pub hidden: bool,
    pub deleted: bool,
}
impl StoredImage {
    fn row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            job: r.get("job")?,
            idx: r.get("idx")?,
            account: r.get("account")?,
            file: r.get("file")?,
            mime: r.get("type")?,
            object_url: r.get("object_url")?,
            preview_url: r.get("preview_url")?,
            created: r.get("created")?,
            hidden: r.get::<_, i64>("hidden")? != 0,
            deleted: r.get::<_, i64>("deleted")? != 0,
        })
    }
}
pub fn images(
    db: &impl repositories::database::Query,
    job: &str,
    admin: bool,
) -> Result<Vec<StoredImage>> {
    Ok(db
        .query_all(
            repositories::statements::images::SELECT_STORED_IMAGES_JOB_DELETED_IDX,
            [job],
            StoredImage::row,
        )?
        .into_iter()
        .filter(|i| {
            i.created
                + if admin {
                    30 * DAY
                } else {
                    USER_IMAGE_RETENTION_MS
                }
                > now()
                && (admin || !i.hidden)
        })
        .collect())
}
pub fn find_image(db: &Connection, job: &str, idx: i64, admin: bool) -> Result<StoredImage> {
    images(db, job, admin)?
        .into_iter()
        .find(|i| i.idx == idx)
        .ok_or_else(|| Error(404, "图片不存在或已过保留期".into()))
}
pub fn public_job(db: &impl repositories::database::Query, job: &str) -> Result<Value> {
    let (status, charged, created, p, r, phase, request_key): (
        String,
        i64,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = db.query_row(
        repositories::statements::images::SELECT_JOBS_ID,
        [job],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, Option<String>>(3)?.unwrap_or("{}".into()),
                r.get::<_, Option<String>>(4)?.unwrap_or("{}".into()),
                r.get(5)?,
                r.get(6)?,
            ))
        },
    )?;
    let p: Value = serde_json::from_str(&p).unwrap_or(json!({}));
    let r: Value = serde_json::from_str(&r).unwrap_or(json!({}));
    let mut v = money(db)?;
    v["requestKey"] = json!(request_key);
    let quota = money(db)?;
    v.as_object_mut().unwrap().extend(json!({"id":job,"status":if status=="queued"{"running"}else{&status},"phase":if status=="queued"{"queued"}else{phase.as_deref().unwrap_or(&status)},"charged":charged as f64/100.,"availableCents":quota["availableCents"],"images":images(db,job,false)?.iter().map(|i|json!({"url":i.object_url.clone().unwrap_or_else(||format!("api/jobs/{job}/images/{}",i.idx)),"previewUrl":i.preview_url.clone(),"downloadUrl":i.object_url.clone().unwrap_or_else(||format!("api/jobs/{job}/images/{}",i.idx)),"type":i.mime,"index":i.idx,"created":i.created,"expiresAt":i.created+USER_IMAGE_RETENTION_MS})).collect::<Vec<_>>(),"error":r["error"].as_str().unwrap_or(""),"created":created,"expiresAt":created+USER_IMAGE_RETENTION_MS,"count":p["count"].as_i64().unwrap_or(1)}).as_object().unwrap().clone());
    Ok(v)
}
pub fn image_type(bytes: &[u8]) -> Result<String> {
    if bytes.len() < 20 || bytes.len() > 32 * 1024 * 1024 {
        return Err(fail("图片文件无效或不完整"));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut pos = 8usize;
        let mut ended = false;
        let mut chunks = 0usize;
        while pos.checked_add(12).is_some_and(|n| n <= bytes.len()) {
            let size = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
            let end = pos
                .checked_add(size)
                .and_then(|n| n.checked_add(12))
                .filter(|n| *n <= bytes.len())
                .ok_or_else(|| fail("PNG容器不完整"))?;
            let kind = &bytes[pos + 4..pos + 8];
            if chunks == 0 && (kind != b"IHDR" || size != 13) {
                return Err(fail("PNG头无效"));
            }
            if crc32fast::hash(&bytes[pos + 4..end - 4])
                != u32::from_be_bytes(bytes[end - 4..end].try_into().unwrap())
            {
                return Err(fail("PNG校验失败"));
            }
            chunks += 1;
            if kind == b"IEND" {
                ended = size == 0 && end == bytes.len();
                break;
            }
            pos = end;
        }
        if !ended {
            return Err(fail("PNG容器不完整"));
        }
    } else if bytes.starts_with(&[255, 216]) {
        if !jpeg_has_complete_image(bytes) {
            return Err(fail("JPEG容器不完整"));
        }
    } else if bytes.starts_with(b"RIFF")
        && (bytes.len() < 12
            || &bytes[8..12] != b"WEBP"
            || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len())
    {
        return Err(fail("WebP容器不完整"));
    }
    let format = image::guess_format(bytes).map_err(|_| fail("图片格式无效"))?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err(fail("不支持的图片格式")),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| fail("图片文件无效或不完整"))?;
    Ok(mime.into())
}

fn jpeg_has_complete_image(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|window| window == [0xff, 0xd9])
}

#[cfg(test)]
mod image_type_tests {
    use super::*;

    fn retention_fixture() -> Connection {
        let db = Connection::Sqlite(rusqlite::Connection::open_in_memory().unwrap());
        migrate(&db).unwrap();
        db
    }

    fn retained_image(db: &Connection, number: i64, age_days: i64, account: &str) -> (String, i64) {
        let job = format!("{number:032x}");
        let created = now() - age_days * DAY;
        db.execute(
            "INSERT INTO jobs(id,account,requestKey,status,created,params,result) VALUES(?,?,?,'done',?,'{}','{}')",
            params![job, account, job, created],
        ).unwrap();
        db.execute(
            "INSERT INTO stored_images(job,idx,account,file,type,created) VALUES(?,0,?,?,'image/png',?)",
            params![job, account, format!("{job}-0"), created],
        ).unwrap();
        (job, created)
    }

    #[test]
    fn user_image_retention_covers_two_weeks_and_preserves_admin_window() {
        let db = retention_fixture();
        let url = url::Url::parse("http://localhost/api/history").unwrap();
        for age in [8, 13, 14, 15, 29, 31] {
            let (job, created) = retained_image(&db, age, age, "owner");
            assert_eq!(find_image(&db, &job, 0, false).is_ok(), age < 14);
            assert_eq!(find_image(&db, &job, 0, true).is_ok(), age < 30);
            let public = public_job(&db, &job).unwrap();
            assert_eq!(public["expiresAt"], created + 14 * DAY);
            assert_eq!(
                public["images"].as_array().unwrap().len(),
                usize::from(age < 14)
            );
            if age < 14 {
                assert_eq!(public["images"][0]["expiresAt"], created + 14 * DAY);
            }
        }
        let history = history(&db, "owner", &url).unwrap();
        assert_eq!(history["retentionDays"], 14);
        assert_eq!(history["total"], 2);
        let records = history["records"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        for record in records {
            assert_eq!(
                record["expiresAt"].as_i64().unwrap(),
                record["created"].as_i64().unwrap() + 14 * DAY
            );
        }
    }

    #[test]
    fn longer_retention_keeps_hidden_deleted_and_other_accounts_out_of_history() {
        let db = retention_fixture();
        let (hidden, _) = retained_image(&db, 1, 8, "owner");
        let (deleted, _) = retained_image(&db, 2, 8, "owner");
        retained_image(&db, 3, 8, "other");
        db.execute("UPDATE stored_images SET hidden=1 WHERE job=?", [&hidden])
            .unwrap();
        db.execute("UPDATE stored_images SET deleted=1 WHERE job=?", [&deleted])
            .unwrap();
        assert!(find_image(&db, &hidden, 0, false).is_err());
        assert!(find_image(&db, &hidden, 0, true).is_ok());
        assert!(find_image(&db, &deleted, 0, false).is_err());
        assert!(find_image(&db, &deleted, 0, true).is_err());
        let url = url::Url::parse("http://localhost/api/history").unwrap();
        let history = history(&db, "owner", &url).unwrap();
        assert_eq!(history["total"], 0);
        assert!(history["records"].as_array().unwrap().is_empty());
    }

    #[test]
    fn accepts_jpeg_eoi_with_trailing_padding() {
        let mut jpeg = vec![0xff, 0xd8];
        jpeg.extend(std::iter::repeat_n(0, 18));
        jpeg.extend([0xff, 0xd9, 0, 0]);
        assert!(jpeg_has_complete_image(&jpeg));
    }

    #[test]
    fn rejects_jpeg_without_eoi() {
        let mut jpeg = vec![0xff, 0xd8];
        jpeg.extend(std::iter::repeat_n(0, 18));
        assert!(!jpeg_has_complete_image(&jpeg));
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let temp = path.with_extension(format!("tmp-{}", id(12)));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&temp, path)?;
        File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temp);
    result
}
pub fn safe_image(a: &App, i: &StoredImage) -> Result<PathBuf> {
    let flat = format!("{}-{}", i.job, i.idx);
    let folder = format!("{}/{}", hash(&i.account), flat);
    if !matches("^[a-f0-9]{32}$", &i.job)
        || !(0..4).contains(&i.idx)
        || (i.file != flat && i.file != folder)
    {
        return Err(fail("图片路径无效"));
    }
    let root = a.data.join("results");
    let target = root.join(&i.file);
    let actual = target.canonicalize()?;
    if actual != target
        || !actual.starts_with(root)
        || !std::fs::symlink_metadata(&target)?.is_file()
    {
        return Err(fail("图片路径无效"));
    }
    Ok(actual)
}
pub fn save_image(
    a: &App,
    job: &str,
    account: &str,
    idx: usize,
    bytes: &[u8],
) -> Result<StoredImage> {
    let mime = image_type(bytes)?;
    if a.config("OSS_PUBLIC_BUCKET").is_empty() || a.config("OSS_PUBLIC_BASE").is_empty() {
        return Err(fail("OSS未配置，无法保存生成图片"));
    }
    let file = format!("{}/{}-{}", hash(account), job, idx);
    let local = std::env::temp_dir().join(format!(
        "jianlai-{}-{}-{}.img",
        job,
        idx,
        rand::random::<u64>()
    ));
    atomic_write(&local, bytes)?;
    let preview = PathBuf::from(format!("{}.webp", local.display()));
    let (object_url, preview_url) = {
        let ffmpeg = if a.config("FFMPEG_BIN").is_empty() {
            "ffmpeg"
        } else {
            a.config("FFMPEG_BIN")
        };
        let converted = match std::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&local)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=1600:1600:force_original_aspect_ratio=decrease",
                "-c:v",
                "libwebp",
                "-quality",
                "78",
                "-compression_level",
                "6",
            ])
            .arg(&preview)
            .arg("-y")
            .output()
        {
            Ok(output) => output,
            Err(error) => {
                let _ = std::fs::remove_file(&local);
                return Err(error.into());
            }
        };
        if !converted.status.success() {
            let _ = std::fs::remove_file(&local);
            return Err(fail("WebP预览生成失败"));
        }
        let ext = if mime == "image/jpeg" { "jpg" } else { "png" };
        let key = format!("results/originals/{file}.{ext}");
        let preview_key = format!("results/previews/{file}.webp");
        let original_name = format!("{job}-{idx}.{ext}");
        if let Err(error) = oss_copy(
            a,
            &local,
            &key,
            &mime,
            "public,max-age=3600",
            Some(&format!("attachment; filename={original_name}")),
        ) {
            let _ = std::fs::remove_file(&local);
            let _ = std::fs::remove_file(&preview);
            return Err(error);
        }
        if let Err(error) = oss_copy(
            a,
            &preview,
            &preview_key,
            "image/webp",
            "public,max-age=3600",
            None,
        ) {
            let _ = oss_remove(a, &key);
            let _ = std::fs::remove_file(&local);
            let _ = std::fs::remove_file(&preview);
            return Err(error);
        }
        let object_url = oss_public_url(a, &key).ok_or_else(|| fail("OSS公开地址未配置"))?;
        let preview_url =
            oss_public_url(a, &preview_key).ok_or_else(|| fail("OSS公开地址未配置"))?;
        let _ = std::fs::remove_file(&local);
        let _ = std::fs::remove_file(&preview);
        (Some(object_url), Some(preview_url))
    };
    Ok(StoredImage {
        job: job.into(),
        idx: idx as i64,
        account: account.into(),
        file,
        mime,
        object_url,
        preview_url,
        created: now(),
        hidden: false,
        deleted: false,
    })
}
pub fn oss_copy(
    a: &App,
    path: &Path,
    key: &str,
    mime: &str,
    cache: &str,
    disposition: Option<&str>,
) -> Result<()> {
    oss_copy_acl(a, path, key, mime, cache, disposition, "public-read")
}
pub fn oss_copy_private(a: &App, path: &Path, key: &str, mime: &str, cache: &str) -> Result<()> {
    oss_copy_acl(a, path, key, mime, cache, None, "private")
}
fn oss_copy_acl(
    a: &App,
    path: &Path,
    key: &str,
    mime: &str,
    cache: &str,
    disposition: Option<&str>,
    acl: &str,
) -> Result<()> {
    let bucket = a.config("OSS_PUBLIC_BUCKET");
    let remote = format!(
        "oss://{bucket}/{}/{}",
        a.config("OSS_PUBLIC_PREFIX").trim_matches('/'),
        key
    );
    let bin = if a.config("OSSUTIL_BIN").is_empty() {
        "aliyun"
    } else {
        a.config("OSSUTIL_BIN")
    };
    let mut cmd = std::process::Command::new(bin);
    cmd.args(["ossutil", "cp"]).arg(path).arg(remote).args([
        "--force",
        "--no-progress",
        "--acl",
        acl,
        "--content-type",
        mime,
        "--cache-control",
        cache,
    ]);
    if let Some(disposition) = disposition {
        cmd.args(["--content-disposition", disposition]);
    }
    if !cmd.output()?.status.success() {
        return Err(fail("OSS图片上传失败"));
    }
    Ok(())
}
pub fn oss_presign(a: &App, key: &str, duration: &str) -> Result<String> {
    let remote = format!(
        "oss://{}/{}/{}",
        a.config("OSS_PUBLIC_BUCKET"),
        a.config("OSS_PUBLIC_PREFIX").trim_matches('/'),
        key
    );
    let bin = if a.config("OSSUTIL_BIN").is_empty() {
        "aliyun"
    } else {
        a.config("OSSUTIL_BIN")
    };
    let output = std::process::Command::new(bin)
        .args([
            "ossutil",
            "presign",
            &remote,
            "--expires-duration",
            duration,
        ])
        .output()?;
    if !output.status.success() {
        return Err(fail("OSS签名URL生成失败"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .map(str::to_owned)
        .ok_or_else(|| fail("OSS签名URL无效"))
}
pub fn oss_public_url(a: &App, key: &str) -> Option<String> {
    if a.config("OSS_PUBLIC_BUCKET").is_empty() || a.config("OSS_PUBLIC_BASE").is_empty() {
        return None;
    }
    Some(format!(
        "{}/{}/{}",
        a.config("OSS_PUBLIC_BASE").trim_end_matches('/'),
        a.config("OSS_PUBLIC_PREFIX").trim_matches('/'),
        key
    ))
}
pub fn oss_remove(a: &App, key: &str) -> Result<()> {
    let bin = if a.config("OSSUTIL_BIN").is_empty() {
        "aliyun"
    } else {
        a.config("OSSUTIL_BIN")
    };
    let remote = format!(
        "oss://{}/{}/{}",
        a.config("OSS_PUBLIC_BUCKET"),
        a.config("OSS_PUBLIC_PREFIX").trim_matches('/'),
        key
    );
    if !std::process::Command::new(bin)
        .args(["ossutil", "rm", &remote, "--force"])
        .output()?
        .status
        .success()
    {
        return Err(fail("OSS图片清理失败"));
    }
    Ok(())
}
pub fn oss_key_from_url(a: &App, value: &str) -> Option<String> {
    let root = format!(
        "{}/{}/",
        a.config("OSS_PUBLIC_BASE").trim_end_matches('/'),
        a.config("OSS_PUBLIC_PREFIX").trim_matches('/')
    );
    value.strip_prefix(&root).map(str::to_owned)
}
pub async fn oss_read(a: &App, url: &str) -> Result<Vec<u8>> {
    let response = a
        .client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| Error(502, "OSS图片读取失败".into()))?;
    if !response.status().is_success() {
        return Err(Error(410, "OSS图片暂时不可用".into()));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|_| Error(502, "OSS图片读取失败".into()))
}
pub fn expire_queued(a: &App) -> Result<()> {
    let db = a.db();
    db.execute(
        repositories::statements::images::UPDATE_JOBS_STATUS_QUEUED_CREATED,
        params![
            json!({"error":"任务排队超时，未扣费，请重新提交"}).to_string(),
            now() - a.queue_wait
        ],
    )?;
    Ok(())
}
fn settle(a: &App, job: &str, found: Vec<StoredImage>, error: &str) -> Result<()> {
    let mut db = a.db();
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (status, reserved, created): (String, i64, i64) = tx.query_row(
        repositories::statements::images::SELECT_JOBS_ID_2,
        [job],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if !["queued", "running"].contains(&status.as_str()) {
        return Ok(());
    }
    let found: Vec<_> = found
        .into_iter()
        .filter(|i| {
            tx.query_row(
                repositories::statements::images::SELECT_STORED_IMAGES_JOB_IDX,
                params![job, i.idx],
                |r| r.get::<_, bool>(0),
            )
            .optional()
            .ok()
            .flatten()
                != Some(true)
        })
        .collect();
    let cost = found.len() as i64 * 30;
    if cost > reserved {
        return Err(fail("任务预留额度异常"));
    }
    if tx.execute(
        repositories::statements::images::UPDATE_SHARED_LEDGER_ID_BALANCE,
        params![cost, cost],
    )? != 1
    {
        return Err(fail("账户余额异常"));
    }
    for i in &found {
        tx.execute(
            repositories::statements::images::INSERT_STORED_IMAGES,
            params![
                job,
                i.idx,
                i.account,
                i.file,
                i.mime,
                created,
                i.object_url,
                i.preview_url
            ],
        )?;
    }
    let original: Option<String> = tx.query_row(
        repositories::statements::images::SELECT_JOBS_ID_3,
        [job],
        |r| r.get(0),
    )?;
    let mut p =
        original.map(|text| serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)));
    if let Some(Value::Object(object)) = &mut p {
        object.insert("references".into(), json!([]));
        object.insert("mask".into(), json!(""));
    }
    tx.execute(repositories::statements::images::UPDATE_JOBS_ID,params![if found.is_empty(){"failed"}else{"done"},if found.is_empty(){"failed"}else{"done"},cost,json!({"error":error,"images":found.iter().map(|i|json!({"index":i.idx,"type":i.mime,"url":i.object_url.clone().unwrap_or_else(||format!("api/jobs/{job}/images/{}",i.idx)),"previewUrl":i.preview_url.clone(),"downloadUrl":i.object_url.clone().unwrap_or_else(||format!("api/jobs/{job}/images/{}",i.idx))})).collect::<Vec<_>>()} ).to_string(),p.map(|value|value.to_string()),job])?;
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
    Ok(())
}
pub async fn execute(a: &App, job: &str, p: Value) {
    let start = (|| -> Result<bool> {
        let db = a.db();
        let changed = db.execute(
            repositories::statements::images::UPDATE_JOBS_ID_STATUS_QUEUED_CREATED,
            params![now(), job, now() - a.queue_wait],
        )?;
        Ok(changed == 1)
    })();
    if start.ok() != Some(true) {
        return;
    }
    let row = a.db().query_row(
        repositories::statements::images::SELECT_JOBS_ID_4,
        [job],
        |r| r.get::<_, String>(0),
    );
    let Ok(account) = row else { return };
    let count = p["count"].as_u64().unwrap_or(1) as usize;
    let mut found = vec![];
    let mut reason = String::new();
    match upstream::generate_detailed(a, &p).await {
        Ok(generated) => {
            reason = generated.warning;
            let bytes = generated.images;
            let _ = a.db().execute(
                repositories::statements::images::UPDATE_JOBS_ID_STATUS_RUNNING,
                [job],
            );
            for (idx, bytes) in bytes.iter().enumerate() {
                match save_image(a, job, &account, idx, bytes) {
                    Ok(i) => {
                        // Journal each published object before settlement so
                        // boot recovery can charge exactly what was delivered.
                        match a.db().execute(
                            repositories::statements::images::INSERT_STORED_IMAGES,
                            params![
                                job,
                                i.idx,
                                i.account,
                                i.file,
                                i.mime,
                                i.created,
                                i.object_url,
                                i.preview_url
                            ],
                        ) {
                            Ok(_) => found.push(i),
                            Err(_) => {
                                for url in [&i.object_url, &i.preview_url].into_iter().flatten() {
                                    if let Some(key) = oss_key_from_url(a, url) {
                                        let _ = oss_remove(a, &key);
                                    }
                                }
                                reason = "图片交付记录保存失败".into();
                                tracing::error!(job, index = idx, "image_journal_failed");
                            }
                        }
                    }
                    Err(_) => {
                        reason = "图片保存失败".into();
                        tracing::error!(job, index = idx, "image_store_failed");
                    }
                }
            }
        }
        Err(e) => tracing::error!(job, code = e.0, "generation_failed"),
    }
    let error = if found.is_empty() {
        "生成未成功，未扣费，请稍后重试".to_owned()
    } else if found.len() < count {
        format!(
            "部分图片生成成功：已完成{}张，未完成{}张，仅按成功图片扣费。原因：{}",
            found.len(),
            count - found.len(),
            if reason.is_empty() {
                "上游未返回足够的有效图片"
            } else {
                &reason
            }
        )
    } else {
        String::new()
    };
    if let Err(e) = settle(a, job, found, &error) {
        tracing::error!(job, code = e.0, "commit_failed"); /* Keep reservation for crash recovery; never silently discard published files. */
    } else if let Some(pool) = a.postgres.clone() {
        let snapshot = a.db().query_row(
            repositories::statements::images::SELECT_JOBS_ID_5,
            [job],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        );
        if let Ok((status, phase, charged, result)) = snapshot {
            let job = job.to_owned();
            tokio::spawn(async move {
                let value = serde_json::from_str(&result).unwrap_or_else(|_| json!({}));
                if let Err(error) = pool
                    .update_job(&job, &status, &phase, charged, &value)
                    .await
                {
                    tracing::error!(job = %job, code = %crate::middleware::postgres_error_code(&error), "postgres_shadow_job_update_failed");
                }
            });
        }
    }
}
pub fn recover(a: &App) -> Result<()> {
    reconcile(a, true)
}
pub fn reconcile(a: &App, boot: bool) -> Result<()> {
    if boot {
        let db = a.db();
        db.execute(
            repositories::statements::images::UPDATE_JOBS_ACCOUNT_ADMIN_TEMPLATE_AUTHORING_STATUS,
            [json!({"error":"服务重启，模板任务未完成，未扣费"}).to_string()],
        )?;
        db.execute(
            repositories::statements::images::UPDATE_AUTHOR_TASKS_STATUS_RUNNING,
            [now()],
        )?;
    }
    let rows = a
        .db()
        .prepare(repositories::statements::images::SELECT_JOBS_STATUS_QUEUED_RUNNING_ACCOUNT_ADMIN)?
        .query_map(
            params![boot, now() - a.queue_wait, now() - 16 * 60000],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (job, account, p) in rows {
        if !matches("^[a-f0-9]{32}$", &job) {
            continue;
        }
        let p: Value = serde_json::from_str(p.as_deref().unwrap_or("{}")).unwrap_or(json!({}));
        let mut found = vec![];
        for idx in 0..p["count"].as_i64().unwrap_or(1).clamp(1, 4) {
            let known = a
                .db()
                .query_row(
                    repositories::statements::images::SELECT_STORED_IMAGES_JOB_IDX_2,
                    params![job, idx],
                    StoredImage::row,
                )
                .optional()?;
            if known.as_ref().is_some_and(|i| i.deleted) {
                continue;
            }
            if let Some(i) = known.as_ref().filter(|i| i.object_url.is_some()) {
                found.push(i.clone());
                continue;
            }
            let files = known.map(|i| vec![i.file]).unwrap_or(vec![
                format!("{}/{}-{}", hash(&account), job, idx),
                format!("{job}-{idx}"),
            ]);
            for file in files {
                let mut i = StoredImage {
                    job: job.clone(),
                    account: account.clone(),
                    idx,
                    file,
                    mime: String::new(),
                    object_url: None,
                    preview_url: None,
                    created: now(),
                    hidden: false,
                    deleted: false,
                };
                if let Ok(bytes) = safe_image(a, &i).and_then(|p| Ok(std::fs::read(p)?)) {
                    if let Ok(mime) = image_type(&bytes) {
                        i.mime = mime;
                        found.push(i);
                        break;
                    }
                }
            }
        }
        let error = if found.is_empty() {
            "服务重启，任务未完成，未扣费"
        } else if found.len() as i64 == p["count"].as_i64().unwrap_or(1) {
            ""
        } else {
            "服务重启，部分图片已恢复，仅按交付图片扣费"
        };
        settle(a, &job, found, error)?;
    }
    Ok(())
}
pub fn remove_image(a: &App, i: &StoredImage) -> Result<()> {
    for url in [&i.object_url, &i.preview_url].into_iter().flatten() {
        if let Some(key) = oss_key_from_url(a, url) {
            oss_remove(a, &key)?;
        }
    }
    match safe_image(a, i) {
        Ok(p) => {
            std::fs::remove_file(&p)?;
            let preview = p.with_extension("webp");
            if preview.exists() {
                std::fs::remove_file(preview)?;
            }
        }
        Err(e) if !a.data.join("results").join(&i.file).exists() => {
            let _ = e;
        }
        Err(e) => return Err(e),
    }
    a.db().execute(
        repositories::statements::images::UPDATE_STORED_IMAGES_JOB_IDX,
        params![i.job, i.idx],
    )?;
    Ok(())
}
pub fn cleanup(a: &App) -> Result<()> {
    let old = a
        .db()
        .prepare(repositories::statements::images::SELECT_STORED_IMAGES_CREATED_DELETED_HIDDEN)?
        .query_map([now() - 30 * DAY], StoredImage::row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for i in old {
        if let Err(e) = remove_image(a, &i) {
            tracing::error!(job = %i.job, code = e.0, "cleanup_image_failed");
        }
    }
    a.db().execute(
        repositories::statements::images::DELETE_ADMIN_SESSIONS_EXPIRES,
        [now()],
    )?;
    templates::cleanup(a)?;
    Ok(())
}
pub fn history(db: &Connection, account: &str, url: &url::Url) -> Result<Value> {
    let args: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let limit = args
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(24)
        .clamp(1, 100);
    let mut cursor = json!({"created":i64::MAX,"job":"ffffffffffffffffffffffffffffffff","index":9});
    if let Some(raw) = args.get("cursor") {
        let b = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| fail("分页标识无效"))?;
        cursor = serde_json::from_slice(&b).map_err(|_| fail("分页标识无效"))?;
        if cursor["created"].as_i64().is_none()
            || !matches("^[a-f0-9]{32}$", strv(&cursor, "job"))
            || cursor["index"].as_i64().is_none()
        {
            return Err(fail("分页标识无效"));
        }
    }
    let rows = db
        .prepare(repositories::statements::images::SELECT_STORED_IMAGES_I_ACCOUNT_I_DELETED_I)?
        .query_map(
            params![
                account,
                now() - USER_IMAGE_RETENTION_MS,
                cursor["created"].as_i64(),
                cursor["created"].as_i64(),
                strv(&cursor, "job"),
                cursor["created"].as_i64(),
                strv(&cursor, "job"),
                cursor["index"].as_i64(),
                limit + 1
            ],
            |r| {
                Ok((
                    StoredImage::row(r)?,
                    r.get::<_, Option<String>>("params")?
                        .unwrap_or_else(|| "{}".into()),
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_next = rows.len() > limit as usize;
    let visible = &rows[..rows.len().min(limit as usize)];
    let next = if has_next {
        let i = &visible.last().unwrap().0;
        Some(
            URL_SAFE_NO_PAD
                .encode(json!({"created":i.created,"job":i.job,"index":i.idx}).to_string()),
        )
    } else {
        None
    };
    let total: i64 = db.query_row(
        repositories::statements::images::SELECT_STORED_IMAGES_ACCOUNT_DELETED_HIDDEN_CREATED,
        params![account, now() - USER_IMAGE_RETENTION_MS],
        |r| r.get(0),
    )?;
    Ok(
        json!({"records":visible.iter().map(|(i,p)|{let p:Value=serde_json::from_str(p).unwrap_or(json!({}));json!({"id":format!("{}-{}",i.job,i.idx),"jobId":i.job,"index":i.idx,"image":i.object_url.clone().unwrap_or_else(||format!("api/jobs/{}/images/{}",i.job,i.idx)),"previewUrl":i.preview_url.clone(),"downloadUrl":i.object_url.clone().unwrap_or_else(||format!("api/jobs/{}/images/{}",i.job,i.idx)),"prompt":strv(&p,"prompt"),"text":strv(&p,"text"),"size":strv(&p,"size"),"quality":strv(&p,"quality"),"mode":strv(&p,"mode"),"supportsFaceSwap":p["supportsFaceSwap"]==true,"faceSwapPrompt":strv(&p,"faceSwapPrompt"),"annotations":p.get("annotations").cloned().unwrap_or(json!([])),"created":i.created,"expiresAt":i.created+USER_IMAGE_RETENTION_MS})}).collect::<Vec<_>>(),"nextCursor":next,"total":total,"retentionDays":USER_IMAGE_RETENTION_DAYS}),
    )
}
