//! Conversational planning endpoint backed by the local Terra gateway.
//!
//! `POST /api/chat` streams Server-Sent Events:
//! `delta` (visible reply text), `plan` (validated generation plan),
//! `done`, or `error`. The assistant never triggers generation itself;
//! the browser submits the plan to `/api/generate` after the user confirms.
use crate::{store, strv, App, Error, Result};
use axum::{
    body::{Body, Bytes},
    http::header,
    response::Response,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};

pub const DAILY_LIMIT: u32 = 50;
pub const HISTORY_LIMIT: usize = 12;
const MESSAGE_MAX_CHARS: usize = 2000;
const REPLY_MAX_CHARS: usize = 20_000;
const CONCURRENCY: usize = 8;
const TIMEOUT: Duration = Duration::from_secs(60);
pub const MARK: &str = "<<<PLAN>>>";
const DEFAULT_BASE: &str = "http://127.0.0.1:3425/v1";
const DEFAULT_MODEL: &str = "gpt-6.1-terra";

const SYSTEM: &str = "你是「剑来生图」的创作助手。用户用中文描述想要的画面或修改意见。\
你的任务：以用户本次明确意图为首要约束，把简略需求补充成可执行的生图方案，不要自己生成图片。\n\
保留用户指定的主体、用途、人物身份、文案语义、风格与否定限制，不得为了美化擅自换题、换人或添加卖点。\
有上传照片时保留照片主体与人物身份；仅借鉴某位名人的风格或服装，不代表要把照片中的人改成该名人。\n\
补充细节必须服务于本次请求：海报、电商或信息图可明确主体位置与占比、标题/正文层级、字重、对齐及留白；\
摄影或插画可明确视角、前中后景、景深、材质，以及光源方向、色温与明暗反差。\
只选与该请求相关的细节，避免堆砌空泛形容词；局部修改只展开要改的部分，保持其余内容。\n\
画面文字放入 text 并逐字保留用户原文（含数字和标点）；不得编造优惠、价格、数据、身份或其他事实。\
用户未要求画面文字时，不擅自增加标题、口号或说明。\n\
回复格式：先用 1-2 句简短中文说明本次具体完善了哪些构图、光影或排版细节，避免只是复述用户原话；\
不得宣称已经搜索、核实或找到参考素材。然后另起一行输出 <<<PLAN>>>，\
紧接一个 JSON 对象，之后不要再输出任何内容。\n\
JSON 字段：\n\
- prompt：完整、具体的中文画面描述（主体、场景、光线、构图、风格），不超过 600 字。\
不要写画幅、比例、尺寸、横版、竖版等词，画幅只由 size 字段决定\n\
- text：画面中必须逐字出现的文字，没有则为空字符串\n\
- size：auto、1024x1024、1536x1024、1024x1536 之一，按用户要求的画幅选择\n\
- quality：auto、low、medium、high 之一，默认 medium\n\
- count：1 或 2，用户想对比多个方案时为 2\n\
- useReference：有参考图且用户要在它的基础上修改时为 true，否则为 false\n\
- publicFigureVisual：必须是布尔值；只有用户明确要把这位公众人物可辨认的脸/身体画进画面时为true。人名仅作为海报标题、文案、名单、祝贺对象、品牌/店名或引用内容时必须false。默认false。\n\
- publicFigures：仅当publicFigureVisual为true且用户明确要求画面描绘广为人知的公众人物时，填写独立姓名的字符串数组，最多2人；两个人必须拆成两个元素，不能把“甲、乙”写为一个姓名。否则必须为空数组。\n\
- publicFigureContext：用于同名消歧的简短职业、节目或代表作，最多80字，例如“超级女声 歌手”，不含场景、隐私或完整用户指令。\n\
- publicFigure：兼容字段，单人姓名或多个姓名用顿号连接；\
普通私人姓名、无法确认的姓名、只把人名印在海报文案、仅提及名人风格或服装时必须留空。\
有参考图也按实际描绘意图判断，不因存在参考图就遗漏明确要求描绘的公众人物\n\
如果用户只是闲聊或问题与画面无关，简短回答，不输出 <<<PLAN>>>。";

/// Per-account daily counters and in-flight flags. Kept in memory on
/// purpose: the limit only guards against abuse, so a restart resetting
/// it is acceptable and avoids a schema change.
#[derive(Default)]
pub struct Usage {
    days: HashMap<String, (i64, u32, bool)>,
}

impl Usage {
    pub fn admit(&mut self, account: &str, day: i64) -> Result<u32> {
        self.days.retain(|_, (d, _, active)| *d == day || *active);
        let key = account.to_owned();
        let entry = self.days.entry(key).or_insert((day, 0, false));
        if entry.0 != day {
            *entry = (day, 0, entry.2);
        }
        if entry.2 {
            return Err(Error(409, "上一条回复还没结束".into()));
        }
        if entry.1 >= DAILY_LIMIT {
            return Err(Error(429, "今日对话次数已用完，可直接按原文生成".into()));
        }
        entry.1 += 1;
        entry.2 = true;
        Ok(entry.1)
    }

    pub fn finish(&mut self, account: &str, day: i64, refund: bool) {
        if let Some(entry) = self.days.get_mut(account) {
            entry.2 = false;
            if refund && entry.0 == day && entry.1 > 0 {
                entry.1 -= 1;
            }
        }
    }

    pub fn used(&self, account: &str, day: i64) -> u32 {
        self.days
            .get(account)
            .filter(|e| e.0 == day)
            .map(|e| e.1)
            .unwrap_or(0)
    }
}

fn usage() -> &'static Mutex<Usage> {
    static USAGE: OnceLock<Mutex<Usage>> = OnceLock::new();
    USAGE.get_or_init(|| Mutex::new(Usage::default()))
}

fn slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(CONCURRENCY)))
        .clone()
}

/// Calendar day in Asia/Shanghai (UTC+8) for a millisecond timestamp.
pub fn shanghai_day(ms: i64) -> i64 {
    (ms + 8 * 3_600_000).div_euclid(crate::DAY)
}

/// Releases the in-flight flag (and optionally refunds) when dropped.
struct Ticket {
    account: String,
    day: i64,
    refund: bool,
    _permit: OwnedSemaphorePermit,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        usage().lock().unwrap_or_else(|e| e.into_inner()).finish(
            &self.account,
            self.day,
            self.refund,
        );
    }
}
/// Validates the browser payload and builds the upstream message list:
/// system prompt, optional reference context, then the last
/// `HISTORY_LIMIT` user/assistant turns.
pub fn build_messages(input: &Value) -> Result<Vec<Value>> {
    let list = input["messages"]
        .as_array()
        .filter(|l| !l.is_empty())
        .ok_or_else(|| crate::fail("请先输入内容"))?;
    let mut turns = Vec::new();
    for m in list {
        let role = strv(m, "role");
        let content = strv(m, "content").trim();
        if !["user", "assistant"].contains(&role) {
            return Err(crate::fail("消息格式无效"));
        }
        if content.chars().count() > MESSAGE_MAX_CHARS {
            return Err(crate::fail("单条消息最多 2000 字"));
        }
        if !content.is_empty() {
            turns.push(json!({"role": role, "content": content}));
        }
    }
    if turns.last().map(|m| strv(m, "role")) != Some("user") {
        return Err(crate::fail("请先输入内容"));
    }
    let skip = turns.len().saturating_sub(HISTORY_LIMIT);
    let mut out = vec![json!({"role": "system", "content": SYSTEM})];
    let reference = strv(&input["reference"], "prompt").trim();
    if !reference.is_empty() {
        let short: String = reference.chars().take(MESSAGE_MAX_CHARS).collect();
        out.push(json!({
            "role": "system",
            "content": format!("当前可作为参考的上一张图，其画面描述是：{short}"),
        }));
    }
    out.extend(turns.into_iter().skip(skip));
    Ok(out)
}

/// Normalises the model's JSON plan. Unknown sizes or qualities fall back
/// to safe defaults; edits with a reference always produce one image
/// because the generation API fixes edit mode to a single result.
pub fn parse_plan(raw: &str, has_reference: bool) -> Option<Value> {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    let v: Value = serde_json::from_str(trimmed.get(start..=end)?).ok()?;
    let prompt: String = strv(&v, "prompt").trim().chars().take(4000).collect();
    if prompt.is_empty() {
        return None;
    }
    let text: String = strv(&v, "text").trim().chars().take(1500).collect();
    let mut size = strv(&v, "size");
    if !store::SIZES.contains(&size) {
        size = "auto";
    }
    let mut quality = strv(&v, "quality");
    if !store::QUALITIES.contains(&quality) {
        quality = "medium";
    }
    let use_reference = has_reference && v["useReference"].as_bool().unwrap_or(true);
    let count = if use_reference || v["count"].as_u64() != Some(2) {
        1
    } else {
        2
    };
    let figure_visual = v["publicFigureVisual"].as_bool().unwrap_or(false);
    let legacy = strv(&v, "publicFigure");
    let mut figures: Vec<String> = if figure_visual {
        v["publicFigures"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .flat_map(figure_names)
            .collect()
    } else {
        Vec::new()
    };
    if figure_visual && figures.is_empty() {
        figures = figure_names(legacy);
    }
    figures.dedup();
    // Keep all explicit identities visible; the UI blocks >2 instead of silently dropping a person.
    figures.truncate(8);
    let public_figure = figures.join("、");
    let figure_context: String = strv(&v, "publicFigureContext")
        .trim()
        .chars()
        .take(80)
        .collect();
    Some(json!({
        "prompt": prompt,
        "text": text,
        "size": size,
        "quality": quality,
        "count": count,
        "useReference": use_reference,
        "publicFigure": public_figure,
        "publicFigures": figures,
        "publicFigureContext": figure_context,
        "publicFigureVisual": figure_visual,
    }))
}
fn figure_names(value: &str) -> Vec<String> {
    value
        .split(['、', '，', ',', '；', ';', '/', '&'])
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= 120)
        .flat_map(|name| {
            for separator in ['与', '和'] {
                if let Some((a, b)) = name.split_once(separator) {
                    if a.trim().chars().count() >= 2 && b.trim().chars().count() >= 2 {
                        return vec![a.trim(), b.trim()];
                    }
                }
            }
            vec![name]
        })
        .map(str::to_owned)
        .collect()
}
/// Separates visible reply text from the plan that follows `MARK`.
/// A trailing fragment that could be the start of `MARK` is held back so
/// the marker never leaks into the chat even when split across chunks.
#[derive(Default)]
pub struct Splitter {
    pending: String,
    plan: Option<String>,
}

impl Splitter {
    pub fn feed(&mut self, chunk: &str) -> String {
        if let Some(plan) = &mut self.plan {
            plan.push_str(chunk);
            return String::new();
        }
        self.pending.push_str(chunk);
        if let Some(i) = self.pending.find(MARK) {
            let visible = self.pending[..i].to_owned();
            self.plan = Some(self.pending[i + MARK.len()..].to_owned());
            self.pending.clear();
            return visible;
        }
        // MARK is ASCII, so the cut point is always a char boundary.
        let keep = (1..MARK.len())
            .rev()
            .find(|&n| self.pending.ends_with(&MARK[..n]))
            .unwrap_or(0);
        let cut = self.pending.len() - keep;
        self.pending.drain(..cut).collect()
    }

    pub fn finish(&mut self) -> (String, Option<String>) {
        (std::mem::take(&mut self.pending), self.plan.take())
    }
}

/// Removes complete lines from `buf` and returns upstream SSE `data:`
/// payloads. Incomplete trailing bytes stay buffered, so multi-byte
/// characters split across network chunks are decoded intact.
pub fn take_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let line = String::from_utf8_lossy(&line);
        if let Some(data) = line.trim().strip_prefix("data:") {
            out.push(data.trim().to_owned());
        }
    }
    out
}

fn delta_text(data: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).ok()?;
    v["choices"][0]["delta"]["content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn event(name: &str, v: &Value) -> Bytes {
    Bytes::from(format!("event: {name}\ndata: {v}\n\n"))
}

pub fn status(account: &str) -> Value {
    let day = shanghai_day(crate::now());
    let used = usage()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .used(account, day);
    json!({"used": used, "limit": DAILY_LIMIT})
}
/// Streams one chat turn. Usage is counted on admission and refunded
/// when nothing reached the browser (upstream down, timeout, empty).
pub async fn handle(a: &App, account: &str, input: Value) -> Result<Response> {
    let messages = build_messages(&input)?;
    let has_reference = input["reference"].is_object();
    let permit = slots()
        .try_acquire_owned()
        .map_err(|_| Error(503, "对话人数较多，请稍后再试".into()))?;
    let day = shanghai_day(crate::now());
    let used = usage()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .admit(account, day)?;
    let mut ticket = Ticket {
        account: account.to_owned(),
        day,
        refund: true,
        _permit: permit,
    };
    let mut base = a.config("CHAT_API_BASE");
    if base.is_empty() {
        base = DEFAULT_BASE;
    }
    let base = base.trim_end_matches('/').to_owned();
    let mut model = a.config("CHAT_MODEL");
    if model.is_empty() {
        model = DEFAULT_MODEL;
    }
    let mut request = a
        .client
        .post(format!("{base}/chat/completions"))
        .timeout(TIMEOUT)
        .json(&json!({"model": model, "stream": true, "messages": messages}));
    let key = a.config("CHAT_API_KEY");
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let (tx, rx) = mpsc::channel::<Bytes>(32);
    tokio::spawn(async move {
        let meta = json!({"used": used, "limit": DAILY_LIMIT});
        let _ = tx.send(event("meta", &meta)).await;
        let mut delivered = false;
        let relayed = relay(request, &tx, has_reference, &mut delivered);
        let error = match tokio::time::timeout(TIMEOUT, relayed).await {
            Ok(error) => error,
            Err(_) => Some("对话超时，可直接按原文生成".to_owned()),
        };
        ticket.refund = !delivered;
        let tail = match error {
            Some(e) => event("error", &json!({"error": e})),
            None => event("done", &json!({})),
        };
        let _ = tx.send(tail).await;
        drop(ticket);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|b| (Ok::<_, std::convert::Infallible>(b), rx))
    });
    let mut r = Response::new(Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        "text/event-stream; charset=utf-8".parse().unwrap(),
    );
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert("x-accel-buffering", "no".parse().unwrap());
    Ok(r)
}

async fn relay(
    request: reqwest::RequestBuilder,
    tx: &mpsc::Sender<Bytes>,
    has_reference: bool,
    delivered: &mut bool,
) -> Option<String> {
    let unavailable = || Some("对话服务暂时不可用，可直接按原文生成".to_owned());
    let response = match request.send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return unavailable(),
    };
    let mut stream = response.bytes_stream();
    let mut buf = Vec::new();
    let mut split = Splitter::default();
    let mut total = 0;
    'read: loop {
        let next = tokio::select! {
            _ = tx.closed() => return None,
            next = stream.next() => next,
        };
        let chunk = match next {
            None => break,
            Some(Ok(chunk)) => chunk,
            Some(Err(_)) => return unavailable(),
        };
        buf.extend_from_slice(&chunk);
        for data in take_lines(&mut buf) {
            if data == "[DONE]" {
                break 'read;
            }
            let text = match delta_text(&data) {
                Some(text) => text,
                None => continue,
            };
            total += text.chars().count();
            if total > REPLY_MAX_CHARS {
                break 'read;
            }
            let visible = split.feed(&text);
            if visible.is_empty() {
                continue;
            }
            let message = event("delta", &json!({"text": visible}));
            if tx.send(message).await.is_err() {
                return None;
            }
            *delivered = true;
        }
    }
    let (rest, plan) = split.finish();
    if !rest.is_empty() {
        let message = event("delta", &json!({"text": rest}));
        if tx.send(message).await.is_ok() {
            *delivered = true;
        }
    }
    let plan = match plan {
        Some(raw) => parse_plan(&raw, has_reference),
        None => None,
    };
    if let Some(plan) = plan {
        if tx.send(event("plan", &plan)).await.is_ok() {
            *delivered = true;
        }
    }
    if !*delivered {
        return Some("对话没有返回内容，可直接按原文生成".to_owned());
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitter_hides_mark_split_across_chunks() {
        let mut s = Splitter::default();
        assert_eq!(s.feed("好的，<<<PL"), "好的，");
        assert_eq!(s.feed("AN>>>{\"prompt\""), "");
        assert_eq!(s.feed(":\"x\"}"), "");
        let (rest, plan) = s.finish();
        assert_eq!(rest, "");
        assert_eq!(plan.as_deref(), Some("{\"prompt\":\"x\"}"));
    }

    #[test]
    fn splitter_releases_held_text_without_mark() {
        let mut s = Splitter::default();
        assert_eq!(s.feed("画面<"), "画面");
        assert_eq!(s.feed("很美"), "<很美");
        assert_eq!(s.finish(), (String::new(), None));
    }

    #[test]
    fn take_lines_keeps_split_utf8_intact() {
        let line = "data: 你好\n".as_bytes();
        let mut buf = line[..8].to_vec();
        assert!(take_lines(&mut buf).is_empty());
        buf.extend_from_slice(&line[8..]);
        assert_eq!(take_lines(&mut buf), vec!["你好".to_owned()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn multi_person_names_are_separate_and_context_is_bounded() {
        let p = parse_plan(r#"{"prompt":"月下跳舞","publicFigureVisual":true,"publicFigures":["厉娜","许飞"],"publicFigureContext":"超级女声 歌手"}"#, false).unwrap();
        assert_eq!(p["publicFigures"], json!(["厉娜", "许飞"]));
        assert_eq!(p["publicFigure"], "厉娜、许飞");
        assert_eq!(p["publicFigureContext"], "超级女声 歌手");
        let p = parse_plan(
            r#"{"prompt":"月下跳舞","publicFigureVisual":true,"publicFigure":"厉娜、许飞"}"#,
            false,
        )
        .unwrap();
        assert_eq!(p["publicFigures"], json!(["厉娜", "许飞"]));
        assert_eq!(figure_names("吴和辉"), vec!["吴和辉"]);
        assert_eq!(figure_names("厉娜和许飞"), vec!["厉娜", "许飞"]);
    }

    #[test]
    fn parse_plan_normalises_fields() {
        let raw = "```json\n{\"prompt\":\" 黄昏水乡 \",\"size\":\"9x9\",\
                   \"quality\":\"ultra\",\"count\":2,\"useReference\":true}\n```";
        let edit = parse_plan(raw, true).unwrap();
        assert_eq!(edit["prompt"], "黄昏水乡");
        assert_eq!(edit["size"], "auto");
        assert_eq!(edit["quality"], "medium");
        assert_eq!(edit["count"], 1);
        assert_eq!(edit["useReference"], true);
        let fresh = parse_plan(raw, false).unwrap();
        assert_eq!(fresh["count"], 2);
        assert_eq!(fresh["useReference"], false);
        assert_eq!(fresh["publicFigure"], "");
        let figure = parse_plan(
            "{\"prompt\":\"生成周杰伦肖像海报\",\"publicFigureVisual\":true,\"publicFigure\":\" 周杰伦 \"}",
            false,
        )
        .unwrap();
        assert_eq!(figure["publicFigure"], "周杰伦");
    }

    #[test]
    fn parse_plan_rejects_missing_prompt() {
        assert!(parse_plan("{\"prompt\":\"\"}", false).is_none());
        assert!(parse_plan("not json", false).is_none());
    }

    #[test]
    fn public_figure_and_uploaded_reference_can_both_guide_an_edit() {
        let raw = r#"{"prompt":"保留上传者，与周杰伦同框","publicFigureVisual":true,"publicFigure":" 周杰伦 ","useReference":true,"count":2}"#;
        let edit = parse_plan(raw, true).unwrap();
        assert_eq!(edit["publicFigure"], "周杰伦");
        assert_eq!(edit["useReference"], true);
        assert_eq!(edit["count"], 1);

        // A name does not manufacture an uploaded reference or force edit mode.
        let fresh = parse_plan(raw, false).unwrap();
        assert_eq!(fresh["publicFigure"], "周杰伦");
        assert_eq!(fresh["useReference"], false);
        assert_eq!(fresh["count"], 2);

        let style_only = parse_plan(
            r#"{"prompt":"保留上传者身份，仅参考周杰伦的服装","publicFigure":"","useReference":true}"#,
            true,
        )
        .unwrap();
        assert_eq!(style_only["publicFigure"], "");
        assert_eq!(style_only["useReference"], true);
    }

    #[test]
    fn a_name_used_only_as_poster_text_never_triggers_figure_search() {
        let plan = parse_plan(
            r#"{"prompt":"做一张演唱会海报，标题写周杰伦巡演","text":"周杰伦巡演","publicFigure":"周杰伦","publicFigures":["周杰伦"]}"#,
            false,
        )
        .unwrap();
        assert_eq!(plan["publicFigureVisual"], false);
        assert_eq!(plan["publicFigure"], "");
        assert_eq!(plan["publicFigures"], json!([]));

        let visual = parse_plan(
            r#"{"prompt":"画周杰伦本人在舞台上唱歌","publicFigureVisual":true,"publicFigure":"周杰伦"}"#,
            false,
        )
        .unwrap();
        assert_eq!(visual["publicFigure"], "周杰伦");
    }

    #[test]
    fn build_messages_keeps_last_turns_and_reference() {
        let list: Vec<Value> = (0..21)
            .map(|i| {
                let role = if i % 2 == 0 { "user" } else { "assistant" };
                json!({"role": role, "content": format!("m{i}")})
            })
            .collect();
        let plain = build_messages(&json!({ "messages": list })).unwrap();
        assert_eq!(plain.len(), 1 + HISTORY_LIMIT);
        assert_eq!(plain.last().unwrap()["content"], "m20");
        let input = json!({"messages": list, "reference": {"prompt": "雾中水乡"}});
        let with_ref = build_messages(&input).unwrap();
        assert_eq!(with_ref.len(), 2 + HISTORY_LIMIT);
    }

    #[test]
    fn build_messages_rejects_bad_input() {
        let last_assistant = json!({"messages": [{"role": "assistant", "content": "x"}]});
        assert!(build_messages(&last_assistant).is_err());
        let bad_role = json!({"messages": [{"role": "system", "content": "x"}]});
        assert!(build_messages(&bad_role).is_err());
        let long = "字".repeat(MESSAGE_MAX_CHARS + 1);
        let too_long = json!({"messages": [{"role": "user", "content": long}]});
        assert!(build_messages(&too_long).is_err());
    }

    #[test]
    fn system_prompt_keeps_ratio_words_out_of_the_prompt_field() {
        // The model follows ratio words in the prompt over the size parameter,
        // so the canvas must come from `size` only.
        assert!(SYSTEM.contains("不要写画幅、比例、尺寸、横版、竖版"));
        assert!(SYSTEM.contains("画幅只由 size 字段决定"));
        assert!(SYSTEM.contains(MARK));
    }
    #[test]
    fn usage_limits_concurrency_and_refunds() {
        let mut u = Usage::default();
        assert_eq!(u.admit("a", 1).unwrap(), 1);
        assert_eq!(u.admit("a", 1).unwrap_err().0, 409);
        u.finish("a", 1, true);
        assert_eq!(u.used("a", 1), 0);
        for _ in 0..DAILY_LIMIT {
            u.admit("a", 1).unwrap();
            u.finish("a", 1, false);
        }
        assert_eq!(u.admit("a", 1).unwrap_err().0, 429);
        assert_eq!(u.admit("a", 2).unwrap(), 1);
    }

    #[test]
    fn shanghai_day_rolls_over_at_local_midnight() {
        let hour = 3_600_000;
        assert_eq!(shanghai_day(16 * hour - 1), 0);
        assert_eq!(shanghai_day(16 * hour), 1);
    }
}
