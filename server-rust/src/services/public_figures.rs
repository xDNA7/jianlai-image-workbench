//! Public, structured identity lookup: only the supplied name leaves this service.
use crate::{Error, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const WIKIDATA: &str = "https://www.wikidata.org/w/api.php";
const COMMONS: &str = "https://commons.wikimedia.org/w/api.php";
const MAX_IMAGE: u64 = 4 * 1024 * 1024;
pub const USER_AGENT: &str = "JianlaiImageWorkbench/2.0 (/templates/v2-ATTRIBUTION.md)";

struct OutboundGate {
    next: Mutex<Instant>,
    turn: tokio::sync::Mutex<()>,
    interval: Duration,
}
impl OutboundGate {
    fn new(interval: Duration) -> Self {
        Self {
            next: Mutex::new(Instant::now()),
            turn: tokio::sync::Mutex::new(()),
            interval,
        }
    }
    async fn slot(&self) -> Instant {
        let _turn = self.turn.lock().await;
        loop {
            let delay = {
                let mut next = self.next.lock().unwrap();
                let now = Instant::now();
                if *next <= now {
                    *next = now + self.interval;
                    return now;
                }
                *next - now
            };
            // Another request can extend the shared cooldown during this sleep.
            tokio::time::sleep(delay).await;
        }
    }
    fn defer(&self, duration: Duration) {
        let now = Instant::now();
        let until = now
            .checked_add(duration)
            .unwrap_or_else(|| now + Duration::from_secs(u32::MAX.into()));
        let mut next = self.next.lock().unwrap();
        *next = (*next).max(until);
    }
}
static OUTBOUND: LazyLock<OutboundGate> =
    LazyLock::new(|| OutboundGate::new(Duration::from_millis(1100)));
pub(crate) async fn outbound_slot() {
    OUTBOUND.slot().await;
}
pub(crate) fn cooldown(seconds: u64) {
    OUTBOUND.defer(Duration::from_secs(seconds));
}

// Long or unparsed Retry-After values never trigger an early retry.
fn response_cooldown(response: &reqwest::Response) -> Option<u64> {
    if !matches!(response.status().as_u16(), 429 | 503) {
        return None;
    }
    let seconds = match response.headers().get(reqwest::header::RETRY_AFTER) {
        Some(value) => value.to_str().ok().and_then(|s| s.parse::<u64>().ok()),
        None => Some(1),
    };
    if let Some(seconds) = seconds {
        cooldown(seconds);
    }
    seconds
}

static SLOTS: Semaphore = Semaphore::const_new(4);
type CachedResult = std::result::Result<SearchResult, (u16, String)>;
static CACHE: LazyLock<Mutex<HashMap<String, (Instant, CachedResult)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub(crate) title: String,
    pub(crate) thumb_url: String,
    pub(crate) image_url: String,
    pub(crate) source_url: String,
    pub(crate) artist: String,
    pub(crate) license: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) license_url: Option<String>,
    pub(crate) entity_id: String,
    pub(crate) person_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    name: String,
    entity_id: String,
    sources: Vec<Source>,
    discovery_channels: Vec<String>,
}

/// Domestic URLs must have been returned by a recent verified source search.
/// Fixed hosts alone are not a generic download proxy authorization.
pub(crate) fn approved_image(url: &url::Url) -> bool {
    if allowed_url(url.as_str(), "upload.wikimedia.org") {
        return true;
    }
    if !super::domestic_images::allowed_image_url(url) {
        return false;
    }
    CACHE.lock().unwrap().values().any(|(at, result)| {
        at.elapsed() < Duration::from_secs(600)
            && result.as_ref().is_ok_and(|result| {
                result.sources.iter().any(|source| {
                    source.image_url == url.as_str() || source.thumb_url == url.as_str()
                })
            })
    })
}

fn network_error() -> Error {
    Error(502, "公开人物图片搜索网络失败，请稍后重试".into())
}
fn normalize(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn validate_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err(Error(400, "公众人物姓名须为 1–120 个字符".into()));
    }
    Ok(name)
}

fn validate_context(context: &str) -> Result<&str> {
    let context = context.trim();
    if context.chars().count() > 80 || context.chars().any(char::is_control) {
        return Err(Error(400, "人物消歧信息最多80字，不能包含控制字符".into()));
    }
    Ok(context)
}
fn context_matches(entity: &Value, context: &str) -> bool {
    let context = context.to_lowercase();
    let occupations: Vec<&str> = entity["claims"]["P106"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|claim| claim["rank"] != "deprecated")
        .filter_map(|claim| claim["mainsnak"]["datavalue"]["value"]["id"].as_str())
        .collect();
    let description = entity["descriptions"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .filter_map(|value| value["value"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let roles: &[(&[&str], &[&str], &[&str])] = &[
        (
            &["歌手", "超级女声", "超女", "歌唱", "singer"],
            &["Q177220", "Q639669", "Q753110"],
            &["singer", "歌手", "歌唱家"],
        ),
        (
            &["演员", "演員", "actor", "actress"],
            &["Q33999", "Q10800557", "Q2405480"],
            &["actor", "actress", "演员", "演員"],
        ),
        (
            &["运动员", "運動員", "athlete"],
            &["Q2066131"],
            &["athlete", "player", "运动员"],
        ),
        (
            &["政治", "politician"],
            &["Q82955"],
            &["politician", "政治"],
        ),
    ];
    roles.iter().any(|(hints, ids, descriptions)| {
        hints.iter().any(|hint| context.contains(hint))
            && (occupations.iter().any(|id| ids.contains(id))
                || descriptions.iter().any(|d| description.contains(d)))
    })
}
fn cached(key: &str) -> Option<Result<SearchResult>> {
    let mut cache = CACHE.lock().unwrap();
    cache.retain(|_, (at, result)| {
        at.elapsed() < Duration::from_secs(if result.is_ok() { 600 } else { 30 })
    });
    cache.get(key).map(|(_, result)| {
        result
            .clone()
            .map_err(|(status, message)| Error(status, message))
    })
}
fn remember(key: String, result: &Result<SearchResult>) {
    let mut cache = CACHE.lock().unwrap();
    if cache.len() >= 128 {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(k, _)| k.clone())
        {
            cache.remove(&oldest);
        }
    }
    // Store only normalized lookup keys and generic local errors; never provider bodies.
    cache.insert(
        key,
        (
            Instant::now(),
            result.as_ref().cloned().map_err(|e| (e.0, e.1.clone())),
        ),
    );
}
pub async fn search(name: String, context: String) -> Result<SearchResult> {
    let context = validate_context(&context)?.to_owned();
    let name = validate_name(&name)?.trim().to_owned();
    let mut result =
        tokio::time::timeout(Duration::from_secs(28), search_inner(name.clone(), context))
            .await
            .map_err(|_| Error(504, "公开人物图片搜索超时，请稍后重试".into()))??;
    result.name = name.to_owned();
    for source in &mut result.sources {
        source.person_name = name.to_owned();
    }
    Ok(result)
}
async fn search_inner(name: String, context: String) -> Result<SearchResult> {
    let key = format!("{}\n{}", normalize(&name), normalize(&context));
    if let Some(result) = cached(&key) {
        return result;
    }
    let flight = {
        let mut flights = IN_FLIGHT.lock().unwrap();
        flights.retain(|_, lock| Arc::strong_count(lock) > 1);
        if flights.len() >= 128 && !flights.contains_key(&key) {
            return Err(Error(429, "人物图片搜索繁忙，请稍后重试".into()));
        }
        flights
            .entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = flight.lock().await;
    if let Some(result) = cached(&key) {
        return result;
    }
    let _permit = SLOTS
        .try_acquire()
        .map_err(|_| Error(429, "人物图片搜索繁忙，请稍后重试".into()))?;
    lookup_bounded(key, Duration::from_secs(26), lookup(name, context)).await
}

// Called while holding the singleflight lock and search permit. Provider timeouts
// become cached errors before the outer deadline can cancel a lock waiter.
async fn lookup_bounded(
    key: String,
    budget: Duration,
    request: impl std::future::Future<Output = Result<SearchResult>>,
) -> Result<SearchResult> {
    if let Some(result) = cached(&key) {
        return result;
    }
    let result = tokio::time::timeout(budget, request)
        .await
        .unwrap_or_else(|_| Err(Error(504, "公开人物图片搜索超时，请稍后重试".into())));
    remember(key, &result);
    result
}

async fn api(
    client: reqwest::Client,
    endpoint: String,
    params: Vec<(String, String)>,
) -> Result<Value> {
    outbound_slot().await;
    let mut response = client
        .get(&endpoint)
        .query(&params)
        .send()
        .await
        .map_err(|_| network_error())?;
    if response_cooldown(&response).is_some_and(|delay| delay <= 3) {
        outbound_slot().await;
        response = client
            .get(&endpoint)
            .query(&params)
            .send()
            .await
            .map_err(|_| network_error())?;
        let _ = response_cooldown(&response);
    }
    if !response.status().is_success() {
        return Err(network_error());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| network_error())?;
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(network_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| network_error())?;
    if result.get("error").is_some() {
        return Err(network_error());
    }
    Ok(result)
}

fn human(entity: &Value) -> bool {
    entity["claims"]["P31"].as_array().is_some_and(|claims| {
        claims
            .iter()
            .any(|c| c["rank"] != "deprecated" && c["mainsnak"]["datavalue"]["value"]["id"] == "Q5")
    })
}
fn exact_name(entity: &Value, name: &str) -> bool {
    let target = normalize(name);
    entity["labels"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .chain(
            entity["aliases"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .flat_map(|a| a.as_array().into_iter().flatten()),
        )
        .any(|label| {
            label["value"]
                .as_str()
                .is_some_and(|value| normalize(value) == target)
        })
}
#[cfg(test)]
fn identify(entities: &Value, name: &str) -> Result<(String, Value)> {
    identify_context(entities, name, "")
}
fn identify_context(entities: &Value, name: &str, context: &str) -> Result<(String, Value)> {
    let mut matches: Vec<_> = entities
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, e)| human(e) && exact_name(e, name))
        .collect();
    if matches.len() > 1 {
        let contextual: Vec<_> = matches
            .iter()
            .copied()
            .filter(|(_, entity)| context_matches(entity, context))
            .collect();
        if !contextual.is_empty() {
            matches = contextual;
        }
    }
    match matches.as_slice() {
        [(id, entity)] => Ok(((*id).clone(), (*entity).clone())),
        [] => Err(Error(
            422,
            "未找到姓名精确匹配的公众人物，请填写完整姓名或常用别名".into(),
        )),
        _ => Err(Error(
            422,
            "姓名对应多位人物，无法安全确定参考对象，请使用更明确的姓名或别名".into(),
        )),
    }
}

type Identity = (String, Value, Vec<String>);
fn primary_api(
    client: &reqwest::Client,
    endpoint: &str,
    params: &[(&str, &str)],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>> {
    let endpoint = endpoint.to_owned();
    let params: Vec<(String, String)> = params
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    let client = client.clone();
    Box::pin(async move {
        tokio::time::timeout(Duration::from_secs(3), api(client, endpoint, params))
            .await
            .map_err(|_| network_error())?
    })
}
async fn primary_identity(
    client: reqwest::Client,
    name: String,
    context: String,
) -> Result<Identity> {
    let mut ids = HashSet::new();
    for language in ["zh", "en"] {
        let value = primary_api(
            &client,
            WIKIDATA,
            &[
                ("action", "wbsearchentities"),
                ("search", &name),
                ("language", language),
                ("limit", "10"),
                ("format", "json"),
            ],
        )
        .await?;
        for item in value["search"].as_array().into_iter().flatten() {
            if let Some(id) = item["id"].as_str().filter(|id| valid_id(id)) {
                ids.insert(id.to_owned());
            }
        }
    }
    if ids.is_empty() {
        return Err(Error(422, "未找到姓名精确匹配的公众人物".into()));
    }
    let mut ids: Vec<_> = ids.into_iter().collect();
    ids.sort();
    let value = primary_api(
        &client,
        WIKIDATA,
        &[
            ("action", "wbgetentities"),
            ("ids", &ids.join("|")),
            ("props", "labels|aliases|descriptions|claims"),
            ("languages", "en|zh|zh-hans|zh-hant|mul"),
            ("format", "json"),
        ],
    )
    .await?;
    let (id, entity) = identify_context(&value["entities"], &name, &context)?;
    Ok((id, entity, vec!["Wikidata".into()]))
}
async fn identity_failover(
    primary: impl std::future::Future<Output = Result<Identity>> + Send + 'static,
    fallback: impl std::future::Future<Output = Result<Identity>> + Send + 'static,
) -> Result<Identity> {
    match primary.await {
        Ok(identity) => Ok(identity),
        // A previously demonstrated ambiguous identity must not become unique
        // merely because another search engine returns fewer candidates.
        Err(error) if error.1.contains("多位人物") => Err(error),
        Err(_) => fallback.await,
    }
}
async fn fallback_identity(
    client: reqwest::Client,
    name: String,
    context: String,
) -> Result<Identity> {
    let discovery = tokio::time::timeout(
        Duration::from_secs(10),
        super::discovery::discover(name.clone()),
    )
    .await
    .map_err(|_| network_error())?;
    let had_response = discovery
        .channel_reports
        .iter()
        .any(|r| matches!(r.status.as_str(), "ok" | "empty"));
    let mut channels: Vec<String> = discovery
        .channel_reports
        .iter()
        .filter(|r| r.status == "ok")
        .map(|r| r.channel.clone())
        .collect();
    let mut ids: HashSet<String> = discovery
        .wikidata_ids
        .into_iter()
        .filter(|id| valid_id(id))
        .collect();
    for title in discovery.wikipedia_titles.into_iter().take(2) {
        let endpoint = match title.language.as_str() {
            "en" => "https://en.wikipedia.org/w/api.php",
            "zh" | "zh-hans" | "zh-hant" => "https://zh.wikipedia.org/w/api.php",
            _ => continue,
        };
        if let Ok(value) = primary_api(
            &client,
            endpoint,
            &[
                ("action", "query"),
                ("titles", &title.title),
                ("prop", "pageprops"),
                ("ppprop", "wikibase_item"),
                ("format", "json"),
            ],
        )
        .await
        {
            for page in value["query"]["pages"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
            {
                if let Some(id) = page["pageprops"]["wikibase_item"]
                    .as_str()
                    .filter(|id| valid_id(id))
                {
                    ids.insert(id.to_owned());
                }
            }
        }
    }
    if ids.is_empty() {
        if !had_response {
            return Err(network_error());
        }
        return Err(Error(
            422,
            "多个公开渠道均未找到可核验的公众人物身份，请填写完整姓名".into(),
        ));
    }
    if ids.len() > 8 {
        return Err(Error(
            422,
            "姓名对应过多身份线索，请使用更明确的姓名或别名".into(),
        ));
    }
    let mut ids: Vec<String> = ids.into_iter().collect();
    ids.sort();
    let joined = ids.join("|");
    let entities = match primary_api(
        &client,
        WIKIDATA,
        &[
            ("action", "wbgetentities"),
            ("ids", &joined),
            ("props", "labels|aliases|descriptions|claims"),
            ("languages", "en|zh|zh-hans|zh-hant|mul"),
            ("format", "json"),
        ],
    )
    .await
    {
        Ok(value) => {
            channels.push("Wikidata".into());
            value["entities"].clone()
        }
        Err(_) => {
            let mut entities = serde_json::Map::new();
            for id in &ids {
                let endpoint =
                    format!("https://www.wikidata.org/wiki/Special:EntityData/{id}.json");
                let value = primary_api(&client, &endpoint, &[]).await?;
                let entity = value["entities"]
                    .get(id)
                    .filter(|e| e.is_object())
                    .ok_or_else(network_error)?;
                entities.insert(id.clone(), entity.clone());
            }
            channels.push("Wikidata EntityData".into());
            Value::Object(entities)
        }
    };
    let (id, entity) = identify_context(&entities, &name, &context)?;
    Ok((id, entity, channels))
}

async fn lookup(name: String, context: String) -> Result<SearchResult> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| network_error())?;
    let (entity_id, entity, mut discovery_channels) = identity_failover(
        primary_identity(client.clone(), name.clone(), context.clone()),
        fallback_identity(client.clone(), name.clone(), context.clone()),
    )
    .await?;
    let languages = if name.is_ascii() {
        ["en", "zh-hans", "zh", "zh-hant", "mul"]
    } else {
        ["zh-hans", "zh", "zh-hant", "en", "mul"]
    };
    let person_name = languages
        .into_iter()
        .find_map(|language| entity["labels"][language]["value"].as_str())
        .unwrap_or(&name);

    let mut pages = Vec::new();
    let mut image_network_failed = false;
    let titles: Vec<_> = entity["claims"]["P18"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["rank"] != "deprecated")
        .filter_map(|c| c["mainsnak"]["datavalue"]["value"].as_str())
        .take(4)
        .map(|s| format!("File:{s}"))
        .collect();
    if !titles.is_empty() {
        let v = primary_api(
            &client,
            COMMONS,
            &[
                ("action", "query"),
                ("titles", &titles.join("|")),
                ("prop", "imageinfo"),
                ("iiprop", "url|mime|size|extmetadata"),
                ("iiurlwidth", "1024"),
                ("format", "json"),
            ],
        )
        .await
        .unwrap_or_else(|_| {
            image_network_failed = true;
            serde_json::json!({})
        });
        pages.extend(
            v["query"]["pages"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .cloned(),
        );
    }
    let query = format!("haswbstatement:P180={entity_id}");
    let v = primary_api(
        &client,
        COMMONS,
        &[
            ("action", "query"),
            ("generator", "search"),
            ("gsrsearch", &query),
            ("gsrnamespace", "6"),
            ("gsrlimit", "12"),
            ("prop", "imageinfo"),
            ("iiprop", "url|mime|size|extmetadata"),
            ("iiurlwidth", "1024"),
            ("format", "json"),
        ],
    )
    .await
    .unwrap_or_else(|_| {
        image_network_failed = true;
        serde_json::json!({})
    });
    let mut extra: Vec<_> = v["query"]["pages"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .cloned()
        .collect();
    extra.sort_by_key(|p| p["index"].as_u64().unwrap_or(u64::MAX));
    pages.extend(extra);
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for page in pages {
        let Some(mut source) = parse_source(&page, &entity_id, person_name) else {
            continue;
        };
        if !seen.insert(source.source_url.clone()) {
            continue;
        }
        // Verify bounded thumbnail size; fallback to the API-sized original when available.
        let info = &page["imageinfo"][0];
        outbound_slot().await;
        let head = client.head(&source.image_url).send().await;
        if let Ok(response) = &head {
            let _ = response_cooldown(response);
        }
        image_network_failed |= head.is_err();
        let thumbnail_ok = head.as_ref().is_ok_and(|r| {
            r.status().is_success()
                && r.headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_some_and(|n| n > 0 && n <= MAX_IMAGE)
                && r.headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|mime| ["image/jpeg", "image/png", "image/webp"].contains(&mime))
        });
        if !thumbnail_ok {
            if !info["size"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= MAX_IMAGE)
            {
                continue;
            }
            source.image_url = info["url"].as_str().unwrap_or_default().to_owned();
            if !allowed_url(&source.image_url, "upload.wikimedia.org") {
                continue;
            }
        }
        sources.push(source);
        if sources.len() == 4 {
            break;
        }
    }
    if sources.len() < 2 {
        let domestic = super::domestic_images::search(
            client.clone(),
            name.clone(),
            entity_id.clone(),
            context.clone(),
        )
        .await;
        if !domestic.is_empty() {
            discovery_channels.push("搜狗图片".into());
            discovery_channels.push("新浪娱乐".into());
            sources.extend(
                domestic.into_iter().filter(|source| {
                    seen.insert(source.source_url.clone() + "#" + &source.image_url)
                }),
            );
            sources.truncate(4);
        }
    }
    if sources.len() < 2 {
        if image_network_failed {
            return Err(network_error());
        }
        return Err(Error(
            422,
            "该人物缺少至少两张可核验来源、许可及大小的独立照片，请手动上传参考图".into(),
        ));
    }
    let titles = sources
        .iter()
        .filter(|source| source.provider.is_none())
        .map(|s| s.title.as_str())
        .collect::<Vec<_>>()
        .join("|");
    let thumbs = if titles.is_empty() {
        serde_json::json!({})
    } else {
        primary_api(
            &client,
            COMMONS,
            &[
                ("action", "query"),
                ("titles", &titles),
                ("prop", "imageinfo"),
                ("iiprop", "url"),
                ("iiurlwidth", "320"),
                ("format", "json"),
            ],
        )
        .await
        .unwrap_or_else(|_| serde_json::json!({}))
    };
    for page in thumbs["query"]["pages"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
    {
        if let Some(source) = sources
            .iter_mut()
            .find(|s| Some(s.title.as_str()) == page["title"].as_str())
        {
            if let Some(small) = page["imageinfo"][0]["thumburl"]
                .as_str()
                .and_then(thumbnail)
            {
                source.thumb_url = small;
            }
        }
    }
    for source in &mut sources {
        source.person_name.clone_from(&name);
    }
    if sources.iter().any(|source| source.provider.is_none()) {
        discovery_channels.push("Wikimedia Commons".into());
    }
    discovery_channels.sort();
    discovery_channels.dedup();
    Ok(SearchResult {
        name: name.to_owned(),
        entity_id,
        sources,
        discovery_channels,
    })
}
fn valid_id(id: &str) -> bool {
    id.starts_with('Q')
        && (2..=24).contains(&id.len())
        && id[1..].bytes().all(|b| b.is_ascii_digit())
}
fn allowed_url(raw: &str, host: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some(host)
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
    })
}
fn thumbnail(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if ![Some("upload.wikimedia.org"), Some("thumb.wikimedia.org")].contains(&url.host_str()) {
        return None;
    }
    url.set_host(Some("upload.wikimedia.org")).ok()?;
    url.set_query(None);
    let raw = url.to_string();
    allowed_url(&raw, "upload.wikimedia.org").then_some(raw)
}
fn plain(raw: &str) -> String {
    static TAGS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<[^>]*>").unwrap());
    TAGS.replace_all(raw, "")
        .chars()
        .filter(|c| !c.is_control())
        .take(500)
        .collect::<String>()
        .trim()
        .to_owned()
}
fn parse_source(page: &Value, id: &str, name: &str) -> Option<Source> {
    let info = &page["imageinfo"][0];
    if !["image/jpeg", "image/png", "image/webp"].contains(&info["mime"].as_str()?) {
        return None;
    }
    let source_url = info["descriptionurl"].as_str()?;
    let page_url = url::Url::parse(source_url).ok()?;
    if !page_url.path().starts_with("/wiki/File:")
        || page_url.query().is_some()
        || page_url.fragment().is_some()
    {
        return None;
    }

    if !allowed_url(source_url, "commons.wikimedia.org")
        || !allowed_url(info["url"].as_str()?, "upload.wikimedia.org")
    {
        return None;
    }
    let meta = &info["extmetadata"];
    let artist = plain(meta["Artist"]["value"].as_str()?);
    let license = plain(meta["LicenseShortName"]["value"].as_str()?);
    if artist.is_empty() || license.is_empty() {
        return None;
    }
    let image_url = thumbnail(info["thumburl"].as_str().or_else(|| info["url"].as_str())?)?;
    let thumb_url = image_url.clone();
    // Wikimedia's supported thumbnail widths are bucketed; use its verified URL.
    let license_url = meta["LicenseUrl"]["value"]
        .as_str()
        .filter(|u| url::Url::parse(u).is_ok_and(|u| u.scheme() == "https"))
        .map(str::to_owned);
    Some(Source {
        title: plain(page["title"].as_str()?),
        thumb_url,
        image_url,
        source_url: source_url.to_owned(),
        artist,
        license,
        license_url,
        entity_id: id.to_owned(),
        person_name: name.to_owned(),
        provider: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn occupation_context_disambiguates_but_never_replaces_exact_identity() {
        let mut singer = person("许飞");
        singer["claims"]["P106"] = json!([{"mainsnak":{"datavalue":{"value":{"id":"Q177220"}}}}]);
        let mut ancient = person("许飞");
        ancient["descriptions"] = json!({"en":{"value":"Song dynasty person"}});
        let identities = json!({"Q6701420":singer.clone(),"Q45498693":ancient});
        assert!(identify_context(&identities, "许飞", "").is_err());
        assert_eq!(
            identify_context(&identities, "许飞", "超级女声 歌手")
                .unwrap()
                .0,
            "Q6701420"
        );
        assert!(identify_context(&identities, "许飞", "月光 华尔兹").is_err());
        assert!(identify_context(&identities, "厉娜", "歌手").is_err());
        let still_ambiguous = json!({"Q1":singer.clone(),"Q2":singer});
        assert!(identify_context(&still_ambiguous, "许飞", "歌手").is_err());
        assert!(validate_context(&"字".repeat(81)).is_err());
        assert!(validate_context("歌手\n秘密").is_err());
    }

    #[test]
    fn domestic_proxy_requires_a_recent_exact_verified_image() {
        let url =
            url::Url::parse("https://www.sinaimg.cn/test-source-authorization-unique.jpg").unwrap();
        let wiki = url::Url::parse("https://upload.wikimedia.org/wikipedia/commons/a/a0/test.jpg")
            .unwrap();
        assert!(approved_image(&wiki));
        assert!(!approved_image(&url));
        let result = SearchResult {
            name: "测试人物".into(),
            entity_id: "Q123".into(),
            discovery_channels: vec![],
            sources: vec![Source {
                title: "测试人物歌手".into(),
                thumb_url: url.to_string(),
                image_url: url.to_string(),
                source_url: "https://ent.sina.com.cn/story.html".into(),
                artist: "新浪娱乐".into(),
                license: "来源页未标注许可，仅作人物参考".into(),
                license_url: None,
                entity_id: "Q123".into(),
                person_name: "测试人物".into(),
                provider: Some("Sogou/Sina".into()),
            }],
        };
        let key = "domestic-proxy-auth-unique".to_owned();
        CACHE
            .lock()
            .unwrap()
            .insert(key.clone(), (Instant::now(), Ok(result.clone())));
        assert!(approved_image(&url));
        assert!(!approved_image(
            &url::Url::parse(&format!("{url}?different=1")).unwrap()
        ));
        CACHE.lock().unwrap().insert(
            key.clone(),
            (Instant::now() - Duration::from_secs(601), Ok(result)),
        );
        assert!(!approved_image(&url));
        CACHE.lock().unwrap().remove(&key);
    }
    fn person(label: &str) -> Value {
        json!({"labels":{"en":{"value":label}},"claims":{"P31":[{"mainsnak":{"datavalue":{"value":{"id":"Q5"}}}}]}})
    }
    #[test]
    fn identity_requires_exact_unique_human() {
        fn assert_send<T: Send>(_: T) {}
        assert_send(super::super::discovery::discover("Taylor Swift".to_owned()));
        assert!(identify(&json!({"Q1":person("Taylor Swift")}), "taylor swift").is_ok());
        assert!(identify(
            &json!({"Q1":person("Taylor Swift"),"Q2":person("Taylor Swift")}),
            "Taylor Swift"
        )
        .is_err());
        assert!(identify(
            &json!({"Q1":person("Taylor Swift tribute")}),
            "Taylor Swift"
        )
        .is_err());
        let mut nonhuman = person("Taylor Swift");
        nonhuman["claims"]["P31"][0]["mainsnak"]["datavalue"]["value"]["id"] = json!("Q482994");
        assert!(identify(&json!({"Q1":nonhuman}), "Taylor Swift").is_err());
        let mut alias = person("Jay Chou");
        alias["aliases"] = json!({"zh":[{"value":"周杰伦"}]});
        assert!(identify(&json!({"Q1":alias}), "周杰伦").is_ok());
    }
    #[test]
    fn input_and_remote_urls_are_bounded() {
        assert!(validate_name("").is_err());
        assert!(validate_name(&"界".repeat(121)).is_err());
        assert!(validate_name("Taylor\nSwift").is_err());
        assert!(thumbnail(
            "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a1/P.jpg/1280px-P.jpg"
        )
        .unwrap()
        .starts_with("https://upload.wikimedia.org/"));
        for url in [
            "http://upload.wikimedia.org/a",
            "https://upload.wikimedia.org.evil.test/a",
            "https://evil.test/a",
            "https://a@upload.wikimedia.org/a",
        ] {
            assert!(!allowed_url(url, "upload.wikimedia.org"));
        }
    }
    #[test]
    fn metadata_and_photo_format_required() {
        let mut page = json!({"title":"File:Portrait.jpg","imageinfo":[{"mime":"image/jpeg","url":"https://upload.wikimedia.org/a.jpg","descriptionurl":"https://commons.wikimedia.org/wiki/File:Portrait.jpg","size":1000,"extmetadata":{"Artist":{"value":"<a>Photographer</a>"},"LicenseShortName":{"value":"CC BY 4.0"}}}]});
        assert_eq!(
            parse_source(&page, "Q1", "Person").unwrap().artist,
            "Photographer"
        );
        page["imageinfo"][0]["mime"] = json!("image/svg+xml");
        assert!(parse_source(&page, "Q1", "Person").is_none());
        page["imageinfo"][0]["mime"] = json!("image/jpeg");
        page["imageinfo"][0]["extmetadata"]["Artist"] = Value::Null;
        assert!(parse_source(&page, "Q1", "Person").is_none());
    }
    #[tokio::test]
    async fn identity_failover_is_lazy_and_keeps_verification() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let fallback_calls = std::sync::Arc::new(AtomicUsize::new(0));
        let primary = async {
            Ok((
                "Q1".to_owned(),
                person("Taylor Swift"),
                vec!["Wikidata".to_owned()],
            ))
        };
        let calls = fallback_calls.clone();
        let fallback = async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(network_error())
        };
        assert_eq!(identity_failover(primary, fallback).await.unwrap().0, "Q1");
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 0);
        let primary = async { Err(network_error()) };
        let calls = fallback_calls.clone();
        let fallback = async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let (id, entity) = identify(&json!({"Q2":person("Different Person")}), "Taylor Swift")?;
            Ok((id, entity, vec!["Wikipedia".to_owned()]))
        };
        assert_eq!(
            identity_failover(primary, fallback).await.unwrap_err().0,
            422
        );
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
        let ambiguous = identify(
            &json!({"Q1":person("Taylor Swift"),"Q2":person("Taylor Swift")}),
            "Taylor Swift",
        )
        .unwrap_err();
        let primary = async { Err(ambiguous) };
        let calls = fallback_calls.clone();
        let fallback = async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(network_error())
        };
        assert!(identity_failover(primary, fallback)
            .await
            .unwrap_err()
            .1
            .contains("多位人物"));
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn unavailable_primary_accepts_only_verified_fallback_identity() {
        let fallback = async {
            let (id, entity) = identify(&json!({"Q26876":person("Taylor Swift")}), "Taylor Swift")?;
            Ok((id, entity, vec!["Wikipedia".to_owned()]))
        };
        let identity = identity_failover(async { Err(network_error()) }, fallback)
            .await
            .unwrap();
        assert_eq!(identity.0, "Q26876");
        assert_eq!(identity.2, vec!["Wikipedia"]);
    }
    #[tokio::test]
    async fn outbound_gate_spaces_concurrent_reservations() {
        let interval = Duration::from_millis(5);
        let gate = Arc::new(OutboundGate::new(interval));
        let mut sends = Vec::new();
        for _ in 0..3 {
            let gate = gate.clone();
            sends.push(tokio::spawn(async move { gate.slot().await }));
        }
        let mut sent = Vec::new();
        for send in sends {
            sent.push(send.await.unwrap());
        }
        sent.sort();
        for pair in sent.windows(2) {
            assert!(pair[1].duration_since(pair[0]) >= interval);
        }
    }
    #[tokio::test]
    async fn outbound_waiter_rechecks_extended_cooldown() {
        let gate = OutboundGate::new(Duration::from_millis(5));
        gate.slot().await;
        let waiter = gate.slot();
        tokio::pin!(waiter);
        assert!(futures_util::poll!(&mut waiter).is_pending());
        let deferred_at = Instant::now();
        let cooldown = Duration::from_millis(20);
        gate.defer(cooldown);
        waiter.await;
        assert!(deferred_at.elapsed() >= cooldown);
    }
    #[tokio::test]
    async fn negative_cache_expires_and_uses_generic_errors() {
        let key = "unit-negative-cache-public-figure".to_owned();
        remember(key.clone(), &Err(Error(422, "人物匹配失败".into())));
        assert_eq!(cached(&key).unwrap().unwrap_err().0, 422);
        CACHE.lock().unwrap().get_mut(&key).unwrap().0 = Instant::now() - Duration::from_secs(31);
        assert!(cached(&key).is_none());
    }
    #[tokio::test]
    async fn slow_provider_timeout_is_cached_without_repeating_lookup() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let key = "unit-slow-provider-public-figure".to_owned();
        let calls = AtomicUsize::new(0);
        for _ in 0..2 {
            let request = async {
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<Result<SearchResult>>().await
            };
            let result = lookup_bounded(key.clone(), Duration::from_millis(5), request).await;
            assert_eq!(result.unwrap_err().0, 504);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cached(&key).unwrap().unwrap_err().0, 504);
        CACHE.lock().unwrap().remove(&key);
    }
    #[tokio::test]
    async fn api_retries_once_for_short_retry_after() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for status in ["429 Too Many Requests", "200 OK"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 1024];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                socket.write_all(format!("HTTP/1.1 {status}\r\nRetry-After: 0\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").as_bytes()).await.unwrap();
            }
        });
        assert_eq!(
            api(reqwest::Client::new(), endpoint, Vec::new())
                .await
                .unwrap(),
            json!({})
        );
        server.await.unwrap();
    }
    #[tokio::test]
    #[ignore = "read-only live Wikimedia integration"]
    async fn live_taylor_swift() {
        let result = search("Taylor Swift".to_owned(), String::new())
            .await
            .unwrap();
        assert_eq!(result.entity_id, "Q26876");
        assert!((2..=4).contains(&result.sources.len()));
        for s in result.sources {
            assert!(allowed_url(&s.image_url, "upload.wikimedia.org"));
            assert!(!s.artist.is_empty());
        }
    }
}
