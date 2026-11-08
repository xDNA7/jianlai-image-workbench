//! Free identity hints only; every candidate still requires exact human validation.
use base64::Engine;
#[cfg(test)]
use futures_util::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use url::Url;

use super::public_figures::{outbound_slot, USER_AGENT};

const CHANNELS: [&str; 5] = [
    "wikipedia_zh",
    "wikipedia_en",
    "google",
    "bing",
    "baidu_baike",
];
const MAX_BODY: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct DiscoveryResult {
    pub wikidata_ids: Vec<String>,
    pub wikipedia_titles: Vec<WikipediaTitle>,
    pub channel_reports: Vec<ChannelReport>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WikipediaTitle {
    pub language: String,
    pub title: String,
}
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChannelReport {
    pub channel: String,
    pub status: String,
}
#[derive(Default)]
struct Hints {
    ids: Vec<String>,
    titles: Vec<WikipediaTitle>,
}
#[derive(Default)]
struct Breaker {
    failures: u8,
    until: Option<Instant>,
}
fn breakers() -> &'static Mutex<HashMap<&'static str, Breaker>> {
    static STATE: OnceLock<Mutex<HashMap<&'static str, Breaker>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn cooling(channel: &'static str) -> bool {
    let mut state = breakers().lock().unwrap_or_else(|e| e.into_inner());
    let breaker = state.entry(channel).or_default();
    if breaker.until.is_some_and(|until| until <= Instant::now()) {
        *breaker = Breaker::default();
    }
    breaker.until.is_some()
}
fn record(channel: &'static str, success: bool) {
    let mut state = breakers().lock().unwrap_or_else(|e| e.into_inner());
    let breaker = state.entry(channel).or_default();
    if success {
        *breaker = Breaker::default();
    } else {
        breaker.failures = breaker.failures.saturating_add(1);
        if breaker.failures >= 3 {
            breaker.until = Some(Instant::now() + Duration::from_secs(300));
        }
    }
}

pub(crate) async fn discover(name: String) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    if name.trim().is_empty() || name.chars().count() > 120 {
        return result;
    }
    let client = match reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_host = attempt
                .previous()
                .first()
                .is_some_and(|first| first.host_str() == attempt.url().host_str());
            if attempt.previous().len() <= 2 && same_host && safe_https(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
    {
        Ok(client) => client,
        Err(_) => return result,
    };
    let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(3));
    let mut pending = tokio::task::JoinSet::new();
    for channel in CHANNELS {
        let client = client.clone();
        let query = name.clone();
        let slots = slots.clone();
        pending.spawn(async move {
            let _permit = slots
                .acquire_owned()
                .await
                .expect("discovery slots remain open");
            if cooling(channel) {
                return (channel, Err("cooldown".to_owned()));
            }
            let outcome =
                tokio::time::timeout(Duration::from_secs(4), search(client, channel, query))
                    .await
                    .unwrap_or_else(|_| Err("timeout".to_owned()));
            record(channel, outcome.is_ok());
            (channel, outcome)
        });
    }
    let deadline = tokio::time::sleep(Duration::from_secs(9));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            item = pending.join_next() => match item {
                None => break,
                Some(Err(_)) => continue,
                Some(Ok((channel, outcome))) => {
                    let status = match outcome {
                        Ok(hints) => {
                            let status = if hints.ids.is_empty() && hints.titles.is_empty() { "empty" } else { "ok" };
                            for id in hints.ids {
                                if result.wikidata_ids.len() + result.wikipedia_titles.len() < 8 && !result.wikidata_ids.contains(&id) { result.wikidata_ids.push(id); }
                            }
                            for title in hints.titles {
                                if result.wikidata_ids.len() + result.wikipedia_titles.len() < 8 && !result.wikipedia_titles.contains(&title) { result.wikipedia_titles.push(title); }
                            }
                            status.to_owned()
                        }
                        Err(status) => status,
                    };
                    result.channel_reports.push(ChannelReport { channel: channel.to_owned(), status });
                }
            }
        }
    }
    for channel in CHANNELS {
        if !result.channel_reports.iter().any(|r| r.channel == channel) {
            result.channel_reports.push(ChannelReport {
                channel: channel.to_owned(),
                status: "timeout".to_owned(),
            });
        }
    }
    result
}

fn safe_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "zh.wikipedia.org"
                    | "en.wikipedia.org"
                    | "www.google.com"
                    | "www.bing.com"
                    | "baike.baidu.com"
            )
        )
}
async fn search(
    client: reqwest::Client,
    channel: &'static str,
    name: String,
) -> Result<Hints, String> {
    let wiki = channel.starts_with("wikipedia_");
    let mut url = Url::parse(match channel {
        "wikipedia_zh" => "https://zh.wikipedia.org/w/api.php",
        "wikipedia_en" => "https://en.wikipedia.org/w/api.php",
        "google" => "https://www.google.com/search",
        "bing" => "https://www.bing.com/search",
        _ => "https://baike.baidu.com/item/",
    })
    .map_err(|_| "invalid_url".to_owned())?;
    if wiki {
        url.query_pairs_mut().extend_pairs([
            ("action", "query"),
            ("format", "json"),
            ("titles", &name),
            ("redirects", "1"),
            ("converttitles", "1"),
            ("prop", "pageprops"),
            ("ppprop", "wikibase_item"),
        ]);
        outbound_slot().await;
    } else if channel == "baidu_baike" {
        url.path_segments_mut()
            .map_err(|_| "invalid_url".to_owned())?
            .pop_if_empty()
            .push(&name);
    } else {
        url.query_pairs_mut().append_pair(
            "q",
            &format!("{name} (site:wikipedia.org OR site:wikidata.org)"),
        );
    }
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "timeout" } else { "network" }.to_owned())?;
    if !response.status().is_success() {
        if wiki && matches!(response.status().as_u16(), 429 | 503) {
            if let Some(seconds) = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
            {
                super::public_figures::cooldown(seconds);
            }
        }
        return Err(format!("http_{}", response.status().as_u16()));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if if wiki {
        mime != "application/json"
    } else {
        !matches!(mime, "text/html" | "application/xhtml+xml")
    } {
        return Err("invalid_content".to_owned());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY as u64)
    {
        return Err("body_too_large".to_owned());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "network".to_owned())? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("body_too_large".to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(body).map_err(|_| "invalid_content".to_owned())?;
    if wiki {
        parse_wikipedia(
            &body,
            if channel == "wikipedia_zh" {
                "zh"
            } else {
                "en"
            },
        )
    } else {
        parse_html(&body)
    }
}
fn valid_id(id: &str) -> bool {
    id.strip_prefix('Q').is_some_and(|digits| {
        !digits.is_empty()
            && digits.len() <= 18
            && !digits.starts_with('0')
            && digits.bytes().all(|b| b.is_ascii_digit())
    })
}
fn parse_wikipedia(body: &str, language: &str) -> Result<Hints, String> {
    let value: Value = serde_json::from_str(body).map_err(|_| "invalid_content".to_owned())?;
    if value.get("error").is_some() {
        return Err("api_error".to_owned());
    }
    let mut hints = Hints::default();
    if let Some(pages) = value["query"]["pages"].as_object() {
        for page in pages.values().take(4) {
            if let Some(id) = page["pageprops"]["wikibase_item"]
                .as_str()
                .filter(|id| valid_id(id))
            {
                hints.ids.push(id.to_owned());
            } else if let Some(title) = page["title"].as_str().filter(|title| valid_title(title)) {
                hints.titles.push(WikipediaTitle {
                    language: language.to_owned(),
                    title: title.to_owned(),
                });
            }
        }
    }
    Ok(hints)
}
fn valid_title(title: &str) -> bool {
    !title.is_empty()
        && title.chars().count() <= 180
        && !title.contains([':', '\n', '\r', '#', '?'])
}
fn blocked(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    [
        "g-recaptcha",
        "h-captcha",
        "cf-chl-",
        "unusual traffic",
        "verify you are human",
        "enable javascript and cookies",
        "/httpservice/retry/enablejs",
        "enable javascript to continue",
        "b_captcha",
        "百度安全验证",
        "请输入验证码",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}
fn parse_html(body: &str) -> Result<Hints, String> {
    if blocked(body) {
        return Err("blocked".to_owned());
    }
    static LINKS: OnceLock<regex::Regex> = OnceLock::new();
    let links = LINKS.get_or_init(|| {
        regex::Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']+)["']"#).expect("constant link regex")
    });
    let mut hints = Hints::default();
    for captures in links.captures_iter(body) {
        let Some(url) = identity_url(&captures[1].replace("&amp;", "&")) else {
            continue;
        };
        let path = url.path();
        if matches!(url.host_str(), Some("www.wikidata.org" | "wikidata.org")) {
            if let Some(id) = path.strip_prefix("/wiki/").filter(|id| valid_id(id)) {
                if !hints.ids.iter().any(|item| item == id) {
                    hints.ids.push(id.to_owned());
                }
            }
        } else if let Some(title) = path.strip_prefix("/wiki/") {
            // URL form decoding handles percent-encoded UTF-8 without another dependency.
            let title =
                url::form_urlencoded::parse(format!("t={}", title.replace('+', "%2B")).as_bytes())
                    .next()
                    .map(|(_, title)| title.replace('_', " "));
            if let Some(title) = title.filter(|title| valid_title(title)) {
                let language = if url.host_str() == Some("zh.wikipedia.org") {
                    "zh"
                } else {
                    "en"
                };
                let title = WikipediaTitle {
                    language: language.to_owned(),
                    title,
                };
                if !hints.titles.contains(&title) {
                    hints.titles.push(title);
                }
            }
        }
        if hints.ids.len() + hints.titles.len() >= 8 {
            break;
        }
    }
    Ok(hints)
}
fn identity_url(raw: &str) -> Option<Url> {
    let wrapped = if raw.starts_with("/url?") {
        format!("https://www.google.com{raw}")
    } else if raw.starts_with("/ck/a?") {
        format!("https://www.bing.com{raw}")
    } else {
        raw.to_owned()
    };
    let mut url = Url::parse(&wrapped).ok()?;
    if url.host_str() == Some("www.google.com") && url.path() == "/url" {
        let target = url
            .query_pairs()
            .find(|(key, _)| key == "q" || key == "url")?
            .1
            .into_owned();
        url = Url::parse(&target).ok()?;
    } else if matches!(url.host_str(), Some("www.bing.com" | "bing.com")) && url.path() == "/ck/a" {
        let target = url
            .query_pairs()
            .find(|(key, _)| key == "u")?
            .1
            .into_owned();
        let encoded = target.strip_prefix("a1")?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded.trim_end_matches('='))
            .ok()?;
        url = Url::parse(std::str::from_utf8(&bytes).ok()?).ok()?;
    }
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !matches!(
            url.host_str(),
            Some("zh.wikipedia.org" | "en.wikipedia.org" | "www.wikidata.org" | "wikidata.org")
        )
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wikipedia_reads_entity_ids_and_rejects_invalid_ids() {
        let hints = parse_wikipedia(r#"{"query":{"pages":{"1":{"title":"Taylor Swift","pageprops":{"wikibase_item":"Q26876"}},"2":{"title":"Fake","pageprops":{"wikibase_item":"Q0"}}}}}"#, "en").unwrap();
        assert_eq!(hints.ids, ["Q26876"]);
        assert_eq!(hints.titles[0].title, "Fake");
    }
    #[test]
    fn search_wrappers_only_accept_known_identity_hosts() {
        let google = parse_html(r#"<a href="/url?q=https%3A%2F%2Fwww.wikidata.org%2Fwiki%2FQ26876&amp;sa=U">person</a>"#).unwrap();
        assert_eq!(google.ids, ["Q26876"]);
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode("https://en.wikipedia.org/wiki/Taylor_Swift");
        let bing = parse_html(&format!(
            r#"<a href="https://www.bing.com/ck/a?u=a1{encoded}">person</a>"#
        ))
        .unwrap();
        assert_eq!(bing.titles[0].title, "Taylor Swift");
        for raw in [
            "https://en.wikipedia.org.evil.test/wiki/Person",
            "https://en.wikipedia.org:444/wiki/Person",
            "https://user@en.wikipedia.org/wiki/Person",
            "https://www.wikidata.org/wiki/Q1?redirect=evil",
        ] {
            assert!(identity_url(raw).is_none());
        }
    }
    #[test]
    fn captcha_and_baike_without_verified_links_provide_no_identity() {
        assert_eq!(
            parse_html("<form class='g-recaptcha'>").err().as_deref(),
            Some("blocked")
        );
        let hints = parse_html(r#"<meta property="og:title" content="泰勒·斯威夫特"><img src="https://bkimg.cdn.bcebos.com/person.jpg"><a href="/item/泰勒">百科</a>"#).unwrap();
        assert!(hints.ids.is_empty() && hints.titles.is_empty());
    }
    #[tokio::test]
    async fn timeout_or_failure_does_not_stop_other_channels() {
        let work = stream::iter([0u8, 1, 2])
            .map(|item| async move {
                tokio::time::timeout(Duration::from_millis(20), async move {
                    match item {
                        0 => {
                            std::future::pending::<()>().await;
                            Ok(0)
                        }
                        1 => Err("network"),
                        _ => Ok(2),
                    }
                })
                .await
            })
            .buffer_unordered(3)
            .collect::<Vec<_>>()
            .await;
        assert!(work.iter().any(Result::is_err));
        assert!(work.iter().any(|item| matches!(item, Ok(Err("network")))));
        assert!(work.iter().any(|item| matches!(item, Ok(Ok(2)))));
    }
}
