use crate::*;
use futures_util::StreamExt;
#[derive(Debug)]
struct UpError {
    status: u16,
    retry: bool,
    key_unavailable: bool,
}
fn classify(status: u16, text: &str, invalid: bool) -> UpError {
    let policy = matches(
        r"(?i)content_policy|moderation|safety_violation|内容违规|内容审核|审核不通过|安全策略",
        text,
    );
    let model_error = matches(
        r"(?i)model.*(not|unavailable|unsupported)|模型.*(不可用|不存在)",
        text,
    );
    let unavailable = !policy
        && !model_error
        && (status == 401
            || status == 402
            || matches(
                r"(?i)insufficient[_ ](quota|balance|credits?)|quota[_ ](exhausted|exceeded)|余额不足|额度不足|额度用尽|欠费",
                text,
            ));
    UpError {
        status,
        retry: !policy
            && (unavailable
                || status >= 500
                || [408, 409, 425, 429].contains(&status)
                || invalid
                || model_error),
        key_unavailable: unavailable,
    }
}
pub async fn limited(
    response: reqwest::Response,
    max: usize,
) -> std::result::Result<Vec<u8>, reqwest::Error> {
    let mut stream = response.bytes_stream();
    let mut data = vec![];
    while let Some(chunk) = stream.next().await {
        let c = chunk?;
        if data.len() + c.len() > max {
            return Ok(vec![]);
        }
        data.extend_from_slice(&c);
    }
    Ok(data)
}
pub fn prompt(p: &Value) -> String {
    let mut s = strv(p, "prompt").to_owned();
    if p["supportsFaceSwap"] == true && p["references"].as_array().is_some_and(|r| !r.is_empty()) {
        s.push_str(&format!("\n【人物替换】\n{}", strv(p, "faceSwapPrompt")));
    }
    if p["compare"] == true && p["count"] == 2 {
        s.push_str(r#"
【对比创作要求】
每个输出图像都必须是一张独立完整的作品，使用完整画幅呈现一个方案。不同输出之间保持主题内容、主体身份、品牌与产品细节、关键文案、画幅和整体创意一致。严格遵守用户明确指定的布局、分镜、多格结构、元素位置及构图约束；在没有这些明确硬性约束的部分，允许构图、元素位置、留白和排版自由探索，形成可供选择的不同方案。不要为了展示对比而在单张图内左右分栏、上下分区、拼接或并排展示多个方案，也不要因对比任务额外添加方案编号、A/B标签或比较说明。用户原本明确要求的漫画多格、分镜、信息分区等作品结构仍须保留；这些结构不代表在图内拼接多个对比方案。"#);
    }
    if let Some(list) = p["annotations"].as_array() {
        if !list.is_empty() {
            s.push_str("\n局部修改清单：坐标按第一张原图归一化；第二张如有红色标记仅作为位置指南，不得画入最终图。");
            for (idx, a) in list.iter().enumerate() {
                s.push_str(&format!(
                    "\n{}. {} ({:.1}%, {:.1}%) {}：{}",
                    idx + 1,
                    if a["type"] == "box" {
                        "框选左上"
                    } else {
                        "目标位置"
                    },
                    a["x"].as_f64().unwrap_or(0.) * 100.,
                    a["y"].as_f64().unwrap_or(0.) * 100.,
                    if a["type"] == "box" {
                        format!(
                            "宽{:.1}% 高{:.1}%",
                            a["w"].as_f64().unwrap_or(0.) * 100.,
                            a["h"].as_f64().unwrap_or(0.) * 100.
                        )
                    } else {
                        "识别附近完整物体".into()
                    },
                    strv(a, "text")
                ));
            }
            s.push_str("\n仅按要求修改，保留其他区域、人物身份、构图、文字、原图尺寸与画幅；不添加标记、编号、红框或十字。");
        }
    }
    if p["references"].as_array().is_some_and(|r| !r.is_empty()) {
        s.push_str(match strv(p, "mode") {
            "edit" => "\n根据要求修改原图，保留未要求修改的区域与主体。",
            "blend" => "\n将参考图主体自然融入新画面，保留身份与产品细节。",
            _ => "\n使用参考图片作为构图与风格参考。",
        });
    }
    if !strv(p, "text").is_empty() {
        s.push_str(&format!(
            "\n海报必须逐字渲染以下文字，保留原标点与换行，禁止添加其他文字：\n{}",
            strv(p, "text")
        ));
    }
    let edited = p["references"].as_array().is_some_and(|r| !r.is_empty());
    if !edited || p["mode"] == "blend" {
        if let Some(note) = canvas_note(strv(p, "size")) {
            s.push_str(&note);
        }
    }
    if p["animation"].is_object() {
        s.push_str(&format!("\n动图输出要求：生成真正的无缝循环 GIF 动图，{} 帧/秒，总时长 {} 秒，共 {} 帧。每帧延时 250 毫秒，帧间动作连续。不要输出静态图片、拼图或分镜表。优先保持主体和动作一致；画幅参数仅为目标，不要为追求分辨率牺牲动画。",
            p["animation"]["fps"], p["animation"]["durationSeconds"], p["animation"]["frames"]));
    }
    s
}
fn generation_body(p: &Value, model: &str, count: usize) -> Value {
    let mut body =
        json!({"model":model,"prompt":prompt(p),"n":count,"size":p["size"],"quality":p["quality"]});
    if !p["animation"].is_object() {
        body["output_format"] = json!("png");
    }
    body
}
fn animation_warning(p: &Value, bytes: &[u8]) -> String {
    if !p["animation"].is_object() {
        return String::new();
    }
    match store::animation_metadata(bytes) {
        Ok(meta) if meta.is_object() && meta["frames"].as_u64().unwrap_or(0) > 1 => {
            let actual_ms = meta["durationMs"].as_f64().unwrap_or(0.);
            let target_ms = p["animation"]["durationSeconds"].as_f64().unwrap_or(3.) * 1000.;
            if meta["frames"] != p["animation"]["frames"] || (actual_ms - target_ms).abs() > 100. {
                format!("动图已保存，实际 {} 帧、{:.2} 秒（{:.2} 帧/秒），与推荐参数有差异；按已交付图片计费，未自动重试。", meta["frames"], actual_ms/1000., meta["fps"].as_f64().unwrap_or(0.))
            } else {
                String::new()
            }
        }
        _ => {
            "模型返回了静态图片，未生成有效动图；已保留原图，按已交付图片计费，未自动重试。".into()
        }
    }
}
/// Pixel size of a requested canvas, e.g. "1536x1024" -> (1536, 1024).
fn canvas(size: &str) -> Option<(u32, u32)> {
    let (w, h) = size.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}
/// The model follows ratio words in the prompt over the size parameter, so the
/// real canvas is restated at the end of the prompt. Not used for edits, which
/// keep the original image's size.
fn canvas_note(size: &str) -> Option<String> {
    let (w, h) = canvas(size)?;
    let shape = match w.cmp(&h) {
        std::cmp::Ordering::Greater => "横版",
        std::cmp::Ordering::Less => "竖版",
        std::cmp::Ordering::Equal => "方形",
    };
    Some(format!(
        "\n画幅要求：最终画幅以 {w}x{h} {shape}为准，\
         忽略上文中与此不一致的比例或横竖版描述，按此画幅重新构图。"
    ))
}
async fn attempt(
    a: &App,
    p: &Value,
    model: &str,
    key: &str,
    base: &str,
    count: usize,
    found: &mut Vec<Vec<u8>>,
) -> std::result::Result<(), UpError> {
    let target = found.len() + count;
    let mut with_mask = !strv(p, "mask").is_empty();
    let response = loop {
        let refs = p["references"].as_array();
        let edited = refs.is_some_and(|r| !r.is_empty());
        let url = format!(
            "{}/images/{}",
            base.trim_end_matches('/'),
            if edited { "edits" } else { "generations" }
        );
        let mut request = a
            .client
            .post(url)
            .bearer_auth(key)
            .header("User-Agent", "ImageWorkbench/Rust")
            .timeout(Duration::from_secs(240));
        let text = prompt(p);
        if edited {
            let mut form = reqwest::multipart::Form::new();
            for (k, v) in [
                ("model", model.to_owned()),
                ("prompt", text),
                ("n", count.to_string()),
                ("size", strv(p, "size").to_owned()),
                ("quality", strv(p, "quality").to_owned()),
            ] {
                form = form.text(k, v);
            }
            if !p["animation"].is_object() {
                form = form.text("output_format", "png");
            }
            for (idx, r) in refs.unwrap().iter().enumerate() {
                let (bytes, mime) = decode_image(r.as_str().unwrap_or(""), 10 * 1024 * 1024)
                    .map_err(|_| classify(400, "invalid image", false))?;
                let part = reqwest::multipart::Part::bytes(bytes)
                    .file_name(format!(
                        "reference-{idx}.{}",
                        if mime == "image/jpeg" {
                            "jpg"
                        } else {
                            mime.split('/').nth(1).unwrap()
                        }
                    ))
                    .mime_str(&mime)
                    .unwrap();
                form = form.part("image[]", part);
            }
            if with_mask {
                let (bytes, _) = decode_image(strv(p, "mask"), 10 * 1024 * 1024)
                    .map_err(|_| classify(400, "invalid mask", false))?;
                form = form.part(
                    "mask",
                    reqwest::multipart::Part::bytes(bytes)
                        .file_name("mask.png")
                        .mime_str("image/png")
                        .unwrap(),
                );
            }
            request = request.multipart(form);
        } else {
            request = request.json(&generation_body(p, model, count));
        }
        let r = request
            .send()
            .await
            .map_err(|_| classify(502, "network", false))?;
        let status = r.status().as_u16();
        let raw = limited(r, 96 * 1024 * 1024)
            .await
            .map_err(|_| classify(502, "network", false))?;
        let data: Value = serde_json::from_slice(&raw)
            .map_err(|_| classify(status, "invalid json", status < 400))?;
        if status >= 400 {
            let message = format!(
                "{} {} {}",
                strv(&data["error"], "code"),
                strv(&data["error"], "message"),
                strv(&data, "message")
            );
            if with_mask
                && status == 400
                && matches(
                    r"(?i)mask.*(unsupported|not supported|unknown|unexpected)|(unknown|unexpected|unsupported).*mask|蒙版.*不支持",
                    &message,
                )
            {
                with_mask = false;
                continue;
            }
            return Err(classify(status, &message, false));
        }
        break data;
    };
    let items = response["data"].as_array().ok_or_else(|| {
        classify(
            200,
            &format!(
                "{} {}",
                strv(&response["error"], "code"),
                strv(&response["error"], "message")
            ),
            true,
        )
    })?;
    let mut valid = false;
    // A provider may repeat an earlier output before the new one. Bound parsing
    // by the supported batch size; the orchestrator caps unique deliveries.
    for item in items.iter().take(4) {
        if found.len() == target {
            break;
        }
        let bytes = if let Some(b64) = item["b64_json"].as_str() {
            if b64.len() > 45 * 1024 * 1024 {
                continue;
            }
            STANDARD.decode(b64).ok()
        } else if let Some(url) = item["url"].as_str() {
            match url::Url::parse(url) {
                Ok(u)
                    if u.scheme() == "https"
                        && u.username().is_empty()
                        && u.password().is_none() =>
                {
                    match a
                        .client
                        .get(u)
                        .timeout(Duration::from_secs(60))
                        .send()
                        .await
                    {
                        Ok(r) if r.status().is_success() && r.url().scheme() == "https" => {
                            limited(r, 32 * 1024 * 1024).await.ok()
                        }
                        _ => None,
                    }
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some(bytes) = bytes {
            if store::image_type(&bytes).is_ok() {
                valid = true;
                if !found.contains(&bytes) {
                    // Commit each validated output before awaiting the next URL.
                    // Cancelling this attempt must not erase completed outputs.
                    found.push(bytes);
                }
            }
        }
    }
    if !valid {
        return Err(classify(502, "invalid images", true));
    }
    Ok(())
}
/// Default order: 2.6 sunburst, 2.6 flare, 2.5 sunburst, 2.5 flare, then 2.0.
/// A model that fails for a retryable reason hands over to the next one (see
/// `classify`).
const DEFAULT_MODELS: [&str; 5] = [
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2",
];
fn models(configured: &str) -> Vec<&str> {
    let list: Vec<&str> = configured
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if list.is_empty() {
        DEFAULT_MODELS.to_vec()
    } else {
        list
    }
}
pub struct Generated {
    pub images: Vec<Vec<u8>>,
    pub warning: String,
}
pub async fn generate(a: &App, p: &Value) -> Result<Vec<Vec<u8>>> {
    Ok(generate_detailed(a, p).await?.images)
}
pub async fn generate_detailed(a: &App, p: &Value) -> Result<Generated> {
    generate_with_limits(a, p, Duration::from_secs(240), Duration::from_secs(720)).await
}
async fn generate_with_limits(
    a: &App,
    p: &Value,
    attempt_limit: Duration,
    total_limit: Duration,
) -> Result<Generated> {
    let count = p["count"].as_u64().unwrap_or(1).clamp(1, 4) as usize;
    // Keep completed outputs outside the timed future: a later timeout must
    // never discard images already generated by a successful request.
    let mut found = vec![];
    let work = async {
        let mut credentials = vec![(a.config("IMAGE_API_KEY"), a.config("IMAGE_API_BASE"))];
        let backup = a.config("IMAGE_API_FALLBACK_KEY");
        let backup_base = if a.config("IMAGE_API_FALLBACK_BASE").is_empty() {
            a.config("IMAGE_API_BASE")
        } else {
            a.config("IMAGE_API_FALLBACK_BASE")
        };
        if !backup.is_empty() && (backup != credentials[0].0 || backup_base != credentials[0].1) {
            credentials.push((backup, backup_base));
        }
        let animated = p["animation"].is_object();
        let models = if animated {
            vec!["gpt-image-2.6"]
        } else {
            models(a.config("IMAGE_MODELS"))
        };
        let mut last = Error(502, "上游未返回足够的有效图片".into());
        let mut unavailable = vec![false; credentials.len()];
        for model in &models {
            for (idx, (key, base)) in credentials.iter().enumerate() {
                if key.is_empty() || unavailable[idx] {
                    continue;
                }
                loop {
                    let before = found.len();
                    match tokio::time::timeout(
                        attempt_limit,
                        attempt(a, p, model, key, base, count - before, &mut found),
                    )
                    .await
                    {
                        Ok(Ok(())) => {
                            if found.len() == count {
                                return Ok(());
                            }
                            if found.len() == before {
                                last = Error(502, "上游返回重复图片，未获得新的独立输出".into());
                                break;
                            }
                            // Only progress permits another call on this route;
                            // at most count-1 such calls across the whole job.
                        }
                        Ok(Err(e)) => {
                            last =
                                Error(e.status, format!("生成服务未完成请求（HTTP {}）", e.status));
                            if animated {
                                return Err(last);
                            }
                            if !e.retry {
                                return Err(last);
                            }
                            if e.key_unavailable {
                                unavailable[idx] = true;
                            }
                            break;
                        }
                        Err(_) => {
                            last = Error(504, "上游生成超时".into());
                            if animated {
                                return Err(last);
                            }
                            break;
                        }
                    }
                }
            }
        }
        Err(last)
    };
    let failure = match tokio::time::timeout(total_limit, work).await {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some(Error(504, "生成超时".into())),
    };
    if found.is_empty() {
        return Err(failure.unwrap_or_else(|| Error(502, "生成未成功".into())));
    }
    let warning = if failure.is_none() {
        found
            .first()
            .map(|bytes| animation_warning(p, bytes))
            .unwrap_or_default()
    } else {
        failure.map(|e| e.1).unwrap_or_default()
    };
    Ok(Generated {
        images: found,
        warning,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn animated_static_delivery_is_not_retried_or_forced_to_png() {
        let (app, seen, server) = stub(vec![(200, output(&[30]))]).await;
        let p = json!({"count":1,"prompt":"循环 GIF","size":"1024x1024","quality":"high","animation":{"fps":4,"durationSeconds":3,"frames":12}});
        let result = generate_detailed(&app, &p).await.unwrap();
        assert_eq!(result.images.len(), 1);
        assert!(result.warning.contains("静态图片"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["model"], "gpt-image-2.6");
        assert!(seen[0].get("output_format").is_none());
        assert!(seen[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("每帧延时 250 毫秒"));
        server.abort();
    }
    #[tokio::test]
    async fn animated_ambiguous_failure_does_not_switch_models_or_credentials() {
        let (app, seen, server) = stub(vec![
            (502, json!({"error":{"message":"unknown"}})),
            (200, output(&[30])),
        ])
        .await;
        let p =
            json!({"count":1,"prompt":"GIF","animation":{"fps":4,"durationSeconds":3,"frames":12}});
        assert!(generate_detailed(&app, &p).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1);
        server.abort();
    }
    fn test_png(color: u8) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            8,
            8,
            image::Rgb([color, 40, 20]),
        ))
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
        out.into_inner()
    }
    async fn stub(
        replies: Vec<(u16, Value)>,
    ) -> (App, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let requests = seen.clone();
        let replies = Arc::new(Mutex::new(std::collections::VecDeque::from(replies)));
        let edit_requests = seen.clone();
        let edit_replies = replies.clone();
        let router = Router::new()
            .route(
                "/images/generations",
                axum::routing::post(move |axum::Json(value): axum::Json<Value>| {
                    let requests = requests.clone();
                    let replies = replies.clone();
                    async move {
                        requests.lock().unwrap().push(value);
                        let (status, value) = replies
                            .lock()
                            .unwrap()
                            .pop_front()
                            .unwrap_or((500, json!({})));
                        if let Some(delay) = value["stub_delay_ms"].as_u64() {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                        reply(status, value)
                    }
                }),
            )
            .route(
                "/images/edits",
                axum::routing::post(move |body: axum::body::Bytes| {
                    let requests = edit_requests.clone();
                    let replies = edit_replies.clone();
                    async move {
                        requests
                            .lock()
                            .unwrap()
                            .push(json!({"multipart": STANDARD.encode(body)}));
                        let (status, value) = replies
                            .lock()
                            .unwrap()
                            .pop_front()
                            .unwrap_or((500, json!({})));
                        reply(status, value)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (sender, _) = mpsc::unbounded_channel();
        let app = App(Arc::new(Inner {
            db: Mutex::new(Connection::open(":memory:").unwrap()),
            data: PathBuf::new(),
            root: PathBuf::new(),
            env: HashMap::from([
                ("IMAGE_API_KEY".into(), "stub-only".into()),
                ("IMAGE_API_BASE".into(), base),
                ("IMAGE_MODELS".into(), "model-a,model-b".into()),
            ]),
            client: reqwest::Client::new(),
            admission: Arc::new(Semaphore::new(1)),
            slots: Arc::new(Semaphore::new(1)),
            video_slots: Arc::new(Semaphore::new(1)),
            sender,
            manifest: Mutex::new(json!({})),
            failures: Mutex::new(HashMap::new()),
            queue_wait: 1,
            postgres: None,
            database_mode: DatabaseMode::Sqlite,
        }));
        (app, seen, task)
    }
    fn output(colors: &[u8]) -> Value {
        json!({"data": colors.iter().map(|c| json!({"b64_json": STANDARD.encode(test_png(*c))})).collect::<Vec<_>>()})
    }
    #[tokio::test]
    async fn identity_samples_reach_provider_as_distinct_image_parts_with_target_canvas() {
        let first = test_png(10);
        let second = test_png(20);
        let (app, seen, server) = stub(vec![(200, output(&[30]))]).await;
        let params = json!({"count":1,"mode":"blend","prompt":"人物身份参考：仅参考身份，另作雨夜街景","size":"1536x1024","quality":"auto","references":[format!("data:image/png;base64,{}",STANDARD.encode(&first)),format!("data:image/png;base64,{}",STANDARD.encode(&second))]});
        let generated = generate(&app, &params).await.unwrap();
        assert_eq!(generated.len(), 1);
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let bytes = STANDARD
            .decode(requests[0]["multipart"].as_str().unwrap())
            .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert_eq!(text.matches("name=\"image[]\"").count(), 2);
        assert!(bytes.windows(first.len()).any(|part| part == first));
        assert!(bytes.windows(second.len()).any(|part| part == second));
        assert!(text.contains("1536x1024 横版"));
        assert!(text.contains("人物身份参考"));
        assert!(!text.contains("根据要求修改原图"));
        server.abort();
    }
    #[tokio::test]
    async fn short_batch_requests_only_missing_output_without_changing_compare_prompt() {
        let (app, seen, server) = stub(vec![(200, output(&[1])), (200, output(&[2, 3]))]).await;
        let params = json!({"count":2,"compare":true,"prompt":"test","size":"1024x1024","quality":"auto","references":[]});
        let generated = generate(&app, &params).await.unwrap();
        server.abort();
        assert_eq!(generated, vec![test_png(1), test_png(2)]);
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.iter()
                .map(|v| v["n"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(seen[0]["model"], seen[1]["model"]);
        assert_eq!(seen[0]["prompt"], seen[1]["prompt"]);
    }
    #[tokio::test]
    async fn missing_output_failure_or_duplicate_retains_success_and_route_budget() {
        for (response, reason) in [
            (
                (400, json!({"error":{"message":"content_policy violation"}})),
                "400",
            ),
            ((429, json!({"error":{"message":"rate limited"}})), "429"),
            ((200, output(&[1])), "重复"),
        ] {
            let (app, seen, server) =
                stub(vec![(200, output(&[1])), response.clone(), response]).await;
            let result = generate_detailed(&app, &json!({"count":2})).await.unwrap();
            server.abort();
            assert_eq!(result.images.len(), 1);
            assert_eq!(result.images[0], test_png(1));
            assert!(result.warning.contains(reason), "{}", result.warning);
            let seen = seen.lock().unwrap();
            let expected = if reason == "400" {
                vec![2, 1]
            } else {
                vec![2, 1, 1]
            };
            assert_eq!(
                seen.iter()
                    .map(|v| v["n"].as_u64().unwrap())
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn supplement_uses_next_model_after_rate_limit_without_repeating_completed_output() {
        let (app, seen, server) = stub(vec![
            (200, output(&[1])),
            (429, json!({"error":{"message":"rate limited"}})),
            (200, output(&[2])),
        ])
        .await;
        let result = generate_detailed(&app, &json!({"count":2})).await.unwrap();
        server.abort();
        assert_eq!(result.images.len(), 2);
        assert!(result.warning.is_empty());
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.iter()
                .map(|v| v["n"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 1, 1]
        );
        assert_eq!(seen[0]["model"], "model-a");
        assert_eq!(seen[1]["model"], "model-a");
        assert_eq!(seen[2]["model"], "model-b");
    }
    #[tokio::test]
    async fn attempt_and_total_timeout_keep_completed_images() {
        for (attempt, total, expected_requests) in [(40, 500, 3), (500, 40, 2)] {
            let delayed = (200, json!({"stub_delay_ms":1000,"data":[]}));
            let (app, seen, server) =
                stub(vec![(200, output(&[1])), delayed.clone(), delayed]).await;
            let result = generate_with_limits(
                &app,
                &json!({"count":2}),
                Duration::from_millis(attempt),
                Duration::from_millis(total),
            )
            .await
            .unwrap();
            server.abort();
            assert_eq!(result.images.len(), 1);
            assert!(result.warning.contains("超时"), "{}", result.warning);
            assert_eq!(seen.lock().unwrap().len(), expected_requests);
        }
    }
    #[tokio::test]
    async fn mixed_response_preserves_decoded_image_when_later_url_times_out() {
        for (attempt, total) in [(100, 1000), (1000, 100)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("https://{}/slow.png", listener.local_addr().unwrap());
            let accepted = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let accepted_copy = accepted.clone();
            // Stall the HTTPS handshake locally: the URL remains in flight
            // past either the attempt deadline or the entire job deadline.
            let slow = tokio::spawn(async move {
                let (_socket, _) = listener.accept().await.unwrap();
                accepted_copy.store(true, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
            let mut response = output(&[1]);
            response["data"]
                .as_array_mut()
                .unwrap()
                .push(json!({"url":url}));
            let (mut app, seen, server) = stub(vec![(200, response)]).await;
            Arc::get_mut(&mut app.0)
                .unwrap()
                .env
                .insert("IMAGE_MODELS".into(), "model-a".into());
            let result = generate_with_limits(
                &app,
                &json!({"count":2}),
                Duration::from_millis(attempt),
                Duration::from_millis(total),
            )
            .await;
            server.abort();
            slow.abort();
            assert!(accepted.load(std::sync::atomic::Ordering::SeqCst));
            let result = result.expect("first decoded image must survive later URL timeout");
            assert_eq!(result.images, vec![test_png(1)]);
            assert!(result.warning.contains("超时"), "{}", result.warning);
            assert_eq!(seen.lock().unwrap().len(), 1);
        }
    }
    #[tokio::test]
    async fn repeated_previous_output_does_not_hide_new_output_in_supplement() {
        let (app, seen, server) = stub(vec![(200, output(&[1])), (200, output(&[1, 2, 3]))]).await;
        let result = generate_detailed(&app, &json!({"count":2})).await.unwrap();
        server.abort();
        assert_eq!(result.images, vec![test_png(1), test_png(2)]);
        assert_eq!(seen.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn duplicate_items_in_one_batch_are_not_delivered_twice() {
        let (app, seen, server) = stub(vec![(200, output(&[1, 1])), (200, output(&[2]))]).await;
        let result = generate_detailed(&app, &json!({"count":2})).await.unwrap();
        server.abort();
        assert_eq!(result.images.len(), 2);
        assert_ne!(result.images[0], result.images[1]);
        assert_eq!(seen.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn single_output_keeps_one_request_and_policy_failure_remains_failure() {
        let (app, seen, server) = stub(vec![(200, output(&[1, 2]))]).await;
        assert_eq!(generate(&app, &json!({"count":1})).await.unwrap().len(), 1);
        server.abort();
        assert_eq!(seen.lock().unwrap().len(), 1);
        let (app, seen, server) = stub(vec![(
            400,
            json!({"error":{"message":"content_policy violation"}}),
        )])
        .await;
        assert!(generate(&app, &json!({"count":2})).await.is_err());
        server.abort();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    #[test]
    fn default_order_is_sunburst_then_flare_down_to_2_0() {
        assert_eq!(
            models(""),
            vec![
                "gpt-image-2.6-sunburst",
                "gpt-image-2.6-flare",
                "gpt-image-2.5-sunburst",
                "gpt-image-2.5-flare",
                "gpt-image-2",
            ]
        );
        let list = models("");
        let unique: std::collections::HashSet<_> = list.iter().collect();
        assert_eq!(unique.len(), list.len());
    }
    fn msg(size: &str, refs: Value) -> Value {
        json!({"prompt": "竖版海报", "size": size, "references": refs})
    }
    #[test]
    fn prompt_restates_the_canvas_unless_auto_or_editing() {
        let wide = prompt(&msg("1536x1024", json!([])));
        assert!(wide.starts_with("竖版海报"));
        assert!(wide.contains("1536x1024 横版"));
        assert!(prompt(&msg("1024x1024", json!([]))).contains("1024x1024 方形"));
        assert!(prompt(&msg("864x1872", json!([]))).contains("864x1872 竖版"));
        assert!(!prompt(&msg("auto", json!([]))).contains("画幅要求"));
        let edit = prompt(&msg("1536x1024", json!(["data:image/png;base64,AA"])));
        assert!(!edit.contains("画幅要求"));
        let mut identity = msg("1536x1024", json!(["photo-one", "photo-two"]));
        identity["mode"] = json!("blend");
        let identity_prompt = prompt(&identity);
        assert!(identity_prompt.contains("1536x1024 横版"));
        assert!(!identity_prompt.contains("根据要求修改原图"));
    }
    #[test]
    fn configured_order_overrides_the_default() {
        assert_eq!(models(" a , ,b,"), vec!["a", "b"]);
        assert_eq!(models("  ,, "), DEFAULT_MODELS.to_vec());
    }
    #[test]
    fn model_and_server_errors_fall_through_but_policy_does_not() {
        // Verbatim relay reply for an unknown model (HTTP 404, type model_not_found).
        let relay = concat!(
            r#"{"error":{"message":"Model \"gpt-image-2.6-sunburst\" is not supported "#,
            r#"by any configured account in this group","type":"model_not_found"}}"#,
        );
        assert!(classify(404, relay, false).retry);
        assert!(!classify(404, relay, false).key_unavailable);
        assert!(classify(404, "The model gpt-image-2.6 does not exist", false).retry);
        assert!(classify(503, "upstream unavailable", false).retry);
        assert!(classify(429, "rate limited", false).retry);
        assert!(!classify(400, "content_policy violation", false).retry);
        assert!(!classify(400, "bad parameter", false).retry);
    }
}
