use crate::*;
use subtle::ConstantTimeEq;
pub fn enabled(a: &App) -> bool {
    matches("^[a-zA-Z0-9_-]{20,100}$", a.config("ADMIN_PATH"))
        && matches("^[a-fA-F0-9]{128}$", a.config("ADMIN_PASSWORD_HASH"))
        && a.config("ADMIN_PASSWORD_SALT").len() >= 16
}
fn state(a: &App, session: Option<&(String, String, i64)>) -> Result<Value> {
    let db = a.db();
    let mut v = store::money(&db)?;
    v["authenticated"] = json!(session.is_some());
    if let Some((_, csrf, expires)) = session {
        v["username"] = json!(a.config("ADMIN_USERNAME"));
        v["csrf"] = json!(csrf);
        v["expiresAt"] = json!(expires);
        let scalar = |sql: &str| -> rusqlite::Result<i64> { db.query_row(sql, [], |r| r.get(0)) };
        v["stats"] = json!({"userCount":db.query_row(repositories::statements::admin::SELECT_STORED_IMAGES_DELETED_CREATED,[now()-30*DAY],|r|r.get::<_,i64>(0))?,"jobCount":scalar(repositories::statements::admin::SELECT_JOBS)?,"imageCount":db.query_row(repositories::statements::admin::SELECT_STORED_IMAGES_DELETED_CREATED_2,[now()-30*DAY],|r|r.get::<_,i64>(0))?,"runningCount":scalar(repositories::statements::admin::SELECT_JOBS_STATUS_QUEUED_RUNNING)?,"totalCharged":scalar(repositories::statements::admin::SELECT_JOBS_2)? as f64/100.,"templateCount":a.manifest.lock().unwrap()["templates"].as_array().unwrap().len()});
    }
    Ok(v)
}
pub async fn handle(
    a: &App,
    path: &str,
    method: &str,
    h: HeaderMap,
    req: Request<Body>,
    peer: SocketAddr,
) -> Result<Response> {
    let prefix = format!("/api/admin/{}", a.config("ADMIN_PATH"));
    let manage = format!("/manage/{}", a.config("ADMIN_PATH"));
    if !enabled(a) {
        return Err(Error(404, "接口不存在".into()));
    }
    if (path == manage || path == format!("{manage}/")) && method == "GET" {
        if method != "GET" {
            return Err(Error(405, "方法不支持".into()));
        }
        // Keep the management application separate from the public workbench.
        let mut r = binary(
            std::fs::read(a.root.join("public/admin-app/index.html"))?,
            "text/html; charset=utf-8",
        );
        r.headers_mut()
            .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
        r.headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        return Ok(r);
    }
    if path.starts_with(&(manage.clone() + "/")) {
        return Err(Error(404, "管理页面不存在".into()));
    }
    let tail = path
        .strip_prefix(&prefix)
        .filter(|s| s.is_empty() || s.starts_with('/'))
        .ok_or_else(|| Error(404, "接口不存在".into()))?;
    if !["GET", "HEAD"].contains(&method) && !same_origin(&h) {
        return Err(Error(403, "请求来源无效".into()));
    }
    if tail == "/login" && method == "POST" {
        let ip = peer.ip().to_string();
        {
            let mut f = a.failures.lock().unwrap();
            f.retain(|_, (_, until)| *until > now());
            if f.get(&ip).is_some_and(|(n, _)| *n >= 5) {
                return Err(Error(429, "登录失败过多，请稍后再试".into()));
            }
        }
        let input = body(req).await?;
        let password = strv(&input, "password").to_owned();
        let salt = a.config("ADMIN_PASSWORD_SALT").to_owned();
        let expected = hex::decode(a.config("ADMIN_PASSWORD_HASH")).unwrap();
        let valid = if password.len() <= 2048 {
            tokio::task::spawn_blocking(move || {
                let mut candidate = [0; 64];
                scrypt::scrypt(
                    password.as_bytes(),
                    salt.as_bytes(),
                    &scrypt::Params::new(14, 8, 1, 64).unwrap(),
                    &mut candidate,
                )
                .is_ok()
                    && bool::from(candidate.ct_eq(&expected))
            })
            .await
            .unwrap_or(false)
        } else {
            false
        };
        if !valid || input["username"] != a.config("ADMIN_USERNAME") {
            let mut f = a.failures.lock().unwrap();
            if f.len() > 10000 {
                f.clear();
            }
            let v = f.entry(ip).or_insert((0, now() + 900000));
            v.0 += 1;
            return Err(Error(401, "账号或密码错误".into()));
        }
        a.failures.lock().unwrap().remove(&ip);
        let raw = id(32);
        let token = hash(&raw);
        let csrf = id(32);
        let hours = a
            .config("ADMIN_SESSION_HOURS")
            .parse::<i64>()
            .unwrap_or(8)
            .clamp(1, 24);
        let expires = now() + hours * 3600000;
        {
            let db = a.db();
            if let Some(old) = cookie(&h, "jianlai_admin_session") {
                db.execute(
                    repositories::statements::admin::DELETE_ADMIN_SESSIONS_TOKEN,
                    [hash(&old)],
                )?;
            }
            db.execute(
                repositories::statements::admin::INSERT_ADMIN_SESSIONS,
                params![token, csrf, now(), expires],
            )?;
        }
        let mut r = reply(200, state(a, Some(&(token, csrf, expires)))?);
        r.headers_mut().insert(header::SET_COOKIE,format!("jianlai_admin_session={raw}; HttpOnly; SameSite=Strict; Path=/jianlai{prefix}/; Max-Age={}; Secure",hours*3600).parse().unwrap());
        return Ok(r);
    }
    let session = {
        let db = a.db();
        cookie(&h, "jianlai_admin_session").and_then(|t| {
            db.query_row(
                repositories::statements::admin::SELECT_ADMIN_SESSIONS_TOKEN_EXPIRES,
                params![hash(&t), now()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten()
        })
    };
    if tail == "/session" && method == "GET" {
        return Ok(reply(200, state(a, session.as_ref())?));
    }
    let session = session.ok_or_else(|| Error(401, "请登录管理员账号".into()))?;
    if !["GET", "HEAD"].contains(&method)
        && h.get("x-csrf-token").and_then(|s| s.to_str().ok()) != Some(&session.1)
    {
        return Err(Error(403, "CSRF校验失败，请刷新管理页面".into()));
    }
    if tail == "/logout" && method == "POST" {
        a.db().execute(
            repositories::statements::admin::DELETE_ADMIN_SESSIONS_TOKEN,
            [session.0],
        )?;
        let mut r = reply(200, json!({"ok":true,"authenticated":false}));
        r.headers_mut().insert(header::SET_COOKIE,format!("jianlai_admin_session=; HttpOnly; SameSite=Strict; Path=/jianlai{prefix}/; Max-Age=0; Secure").parse().unwrap());
        return Ok(r);
    }
    if tail == "/recharge" && method == "POST" {
        let input = body(req).await?;
        let amount = strv(&input, "amount");
        let key = strv(&input, "requestKey");
        if !matches(r"^(0|[1-9]\d{0,7})(\.\d{1,2})?$", amount)
            || !matches("^[a-zA-Z0-9_-]{16,100}$", key)
        {
            return Err(fail("金额或幂等标识无效"));
        }
        let mut parts = amount.split('.');
        let whole = parts.next().unwrap().parse::<i64>().unwrap();
        let decimal = format!("{:<02}", parts.next().unwrap_or("")).replace(' ', "0");
        let cents = whole * 100 + decimal.parse::<i64>().unwrap_or(0);
        if cents <= 0 {
            return Err(fail("充值金额必须大于0"));
        }
        let mut db = a.db();
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous = tx
            .query_row(
                repositories::statements::admin::SELECT_RECHARGES,
                [key],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let duplicate = previous.is_some();
        let row = if let Some(row) = previous {
            if row.1 != cents {
                return Err(Error(409, "相同充值标识对应不同金额".into()));
            }
            row
        } else {
            let balance: i64 = tx.query_row(
                repositories::statements::admin::SELECT_SHARED_LEDGER_ID,
                [],
                |r| r.get(0),
            )?;
            if balance + cents > 9_007_199_254_740_991 {
                return Err(fail("余额超出安全范围"));
            }
            let row = (id(16), cents, now());
            tx.execute(
                repositories::statements::admin::INSERT_RECHARGES,
                params![row.0, key, cents, row.2],
            )?;
            tx.execute(
                repositories::statements::admin::UPDATE_SHARED_LEDGER_ID,
                [cents],
            )?;
            row
        };
        tx.commit()?;
        if !duplicate {
            if let Some(pool) = a.postgres.clone() {
                let recharge_id = row.0.clone();
                let request_key = key.to_owned();
                let recharge_amount = row.1;
                let recharge_created = row.2;
                tokio::spawn(async move {
                    if let Err(error) = pool
                        .insert_recharge(
                            &recharge_id,
                            &request_key,
                            recharge_amount,
                            recharge_created,
                        )
                        .await
                    {
                        eprintln!("postgres_shadow_recharge_write_failed error={error}");
                    }
                });
            }
        }
        let mut v = store::money(&db)?;
        v["duplicate"] = json!(duplicate);
        v["recharge"] =
            json!({"id":row.0,"amount":row.1 as f64/100.,"amountCents":row.1,"created":row.2});
        return Ok(reply(200, v));
    }
    if tail == "/templates" && method == "GET" {
        return Ok(reply(200, a.manifest.lock().unwrap().clone()));
    }
    if tail == "/templates" && method == "POST" {
        let input = body(req).await?;
        let t = templates::validate(a, input["template"].clone())?;
        templates::save(a, &t)?;
        return Ok(reply(
            200,
            json!({"ok":true,"template":t,"updatedAt":now()}),
        ));
    }
    if tail == "/templates/author" && method == "POST" {
        return templates::submit(a, body(req).await?).await;
    }
    if let Some(task) = tail.strip_prefix("/templates/author/") {
        if method == "GET" && matches("^[a-f0-9]{32}$", task) {
            return Ok(reply(200, templates::public_task(a, task)?));
        }
    }
    if let Some(tid) = tail.strip_prefix("/templates/") {
        if method == "DELETE" && matches("^[a-zA-Z0-9_-]{1,80}$", tid) {
            templates::delete(a, tid)?;
            return Ok(reply(200, json!({"ok":true,"updatedAt":now()})));
        }
    }
    if tail == "/users" && method == "GET" {
        let db = a.db();
        let rows = db
            .prepare(repositories::statements::admin::SELECT_ACCOUNTS)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut users = vec![];
        let cutoff = now() - 30 * DAY;
        for (id, created, _, jobs, charged) in rows {
            let (count, last): (i64, Option<i64>) = db.query_row(
                repositories::statements::admin::SELECT_STORED_IMAGES_ACCOUNT_DELETED_CREATED,
                params![id, cutoff],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            users.push(json!({"id":id,"created":created,"lastCreated":last,"jobCount":jobs,"totalCharged":charged as f64/100.,"imageCount":count}));
        }
        users.sort_by(|a, b| {
            b["lastCreated"]
                .as_i64()
                .cmp(&a["lastCreated"].as_i64())
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        return Ok(reply(200, json!({"users":users})));
    }
    if let Some(c) = regex::Regex::new(r"^/users/([a-f0-9]{32,64})/images$")
        .unwrap()
        .captures(tail)
    {
        if method == "GET" {
            let db = a.db();
            let account = &c[1];
            let images=db.prepare(repositories::statements::admin::SELECT_STORED_IMAGES_I_ACCOUNT_I_DELETED_I)?.query_map(params![account,now()-30*DAY],|r|{let job=r.get::<_,String>(0)?;let idx=r.get::<_,i64>(1)?;let created=r.get::<_,i64>(2)?;let p:Value=serde_json::from_str(&r.get::<_,Option<String>>(4)?.unwrap_or_else(||"{}".into())).unwrap_or(json!({}));let original=r.get::<_,Option<String>>(5)?;let preview=r.get::<_,Option<String>>(6)?;Ok(json!({"id":format!("{job}-{idx}"),"jobId":job,"index":idx,"url":preview.clone().or(original.clone()),"downloadUrl":original,"created":created,"expiresAt":created+30*DAY,"prompt":strv(&p,"prompt"),"text":strv(&p,"text"),"hiddenUser":r.get::<_,bool>(3)?||created+store::USER_IMAGE_RETENTION_MS<=now()}))})?.collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(reply(200, json!({"images":images})));
        }
    }
    if let Some(c) = regex::Regex::new(r"^/images/([a-f0-9]{32})/(\d)$")
        .unwrap()
        .captures(tail)
    {
        let i = store::find_image(&a.db(), &c[1], c[2].parse().unwrap(), true)?;
        if method == "DELETE" {
            store::remove_image(a, &i)?;
            return Ok(reply(200, json!({"ok":true})));
        }
        if method == "GET" {
            let mut remote_error = None;
            let original = i
                .object_url
                .as_deref()
                .filter(|url| Some(*url) != i.preview_url.as_deref());
            for (url, mime) in [
                (i.preview_url.as_deref(), "image/webp"),
                (original, i.mime.as_str()),
            ] {
                if let Some(url) = url {
                    match store::oss_read(a, url).await {
                        Ok(bytes) => return Ok(binary(bytes, mime)),
                        Err(error) => remote_error = Some(error),
                    }
                }
            }
            let local =
                store::safe_image(a, &i).and_then(|path| std::fs::read(path).map_err(Error::from));
            return match local {
                Ok(bytes) => Ok(binary(bytes, &i.mime)),
                Err(error) => Err(remote_error.unwrap_or(error)),
            };
        }
    }
    Err(Error(404, "接口不存在".into()))
}
