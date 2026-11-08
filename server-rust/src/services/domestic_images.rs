//! Free discovery is only accepted after the original publisher binds each image to the person.
use futures_util::StreamExt;
use serde_json::Value;
use std::{collections::HashSet, time::Duration};
use url::Url;

use super::public_figures::Source;

const LIMIT: usize = 2 * 1024 * 1024;
const ROLES: &[&str] = &[
    "歌手",
    "超级女声",
    "超女",
    "演员",
    "演員",
    "运动员",
    "運動員",
    "政治家",
    "作家",
    "音乐人",
];
const GROUPS: &[&str] = &["合影", "大合照", "全家福", "同框", "合照"];

fn safe_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
}

pub(crate) fn allowed_image_url(url: &Url) -> bool {
    safe_https(url)
        && matches!(
            url.host_str(),
            Some("image2.sina.com.cn" | "www.sinaimg.cn")
        )
}

pub(crate) fn allowed_source_url(url: &Url) -> bool {
    safe_https(url)
        && matches!(
            url.host_str(),
            Some("ent.sina.com.cn" | "slide.ent.sina.com.cn")
        )
}

fn normalize_url(raw: &str, image: bool) -> Option<Url> {
    let raw = raw.replace("&amp;", "&");
    let raw = if raw.starts_with("//") {
        format!("https:{raw}")
    } else if let Some(tail) = raw.strip_prefix("http://") {
        format!("https://{tail}")
    } else {
        raw
    };
    let url = Url::parse(&raw).ok()?;
    (if image {
        allowed_image_url(&url)
    } else {
        allowed_source_url(&url)
    })
    .then_some(url)
}

// Deserialize one JSON value; never evaluate provider JavaScript or unescape JSON twice.
fn assigned_json(html: &str, marker: &str) -> Option<Value> {
    let tail = html.split_once(marker)?.1.trim_start();
    let tail = tail.strip_prefix('=')?.trim_start();
    let mut values = serde_json::Deserializer::from_str(tail).into_iter::<Value>();
    values.next()?.ok()
}

fn plain_text(html: &str) -> String {
    static TAGS: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?s)<[^>]*>").unwrap());
    TAGS.replace_all(html, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn identity(text: &str, name: &str, context: &str) -> bool {
    if !text.contains(name) {
        return false;
    }
    let aliases: &[&[&str]] = &[
        &["歌手", "超级女声", "超女", "音乐人", "singer"],
        &["演员", "演員", "actor", "actress"],
        &["运动员", "運動員", "athlete"],
        &["政治家", "politician"],
        &["作家", "writer"],
    ];
    let requested: Vec<_> = aliases
        .iter()
        .filter(|roles| roles.iter().any(|r| context.contains(r)))
        .collect();
    if requested.is_empty() {
        ROLES.iter().any(|role| text.contains(role))
    } else {
        requested
            .iter()
            .any(|roles| roles.iter().any(|role| text.contains(role)))
    }
}

fn group(title: &str) -> bool {
    GROUPS.iter().any(|word| title.contains(word))
}

async fn page(client: &reqwest::Client, url: Url) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > LIMIT as u64)
    {
        return None;
    }
    let headers = response.headers().clone();
    if headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| !s.starts_with("text/html"))
    {
        return None;
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.ok()?;
        if bytes.len() + chunk.len() > LIMIT {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let default = if prefix.contains("charset=gb") || prefix.contains("charset=\"gb") {
        "gbk"
    } else {
        "utf-8"
    };
    // Rebuild the bounded body so reqwest's charset decoder handles legacy publisher pages.
    let mut bounded = axum::http::Response::new(bytes);
    *bounded.headers_mut() = headers;
    let html = reqwest::Response::from(bounded)
        .text_with_charset(default)
        .await
        .ok()?;
    if ["Sina Visitor System", "访问过于频繁", "安全验证", "验证码"]
        .iter()
        .any(|s| html.contains(s))
    {
        return None;
    }
    Some(html)
}

#[derive(Clone)]
struct Candidate {
    title: String,
    image: Url,
    source: Url,
}

fn candidates(html: &str, name: &str) -> Vec<Candidate> {
    let Some(state) = assigned_json(html, "window.__INITIAL_STATE__") else {
        return vec![];
    };
    state["searchList"]["searchList"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let title = row["title"].as_str()?;
            if !title.contains(name) || group(title) {
                return None;
            }
            let source_raw = row["url"].as_str()?;
            let source = normalize_source(source_raw)?;
            Some(Candidate {
                title: title.into(),
                image: normalize_url(row["oriPicUrl"].as_str()?, true)?,
                source,
            })
        })
        .collect()
}

fn normalize_source(raw: &str) -> Option<Url> {
    let normalized = raw.replace("&amp;", "&");
    let normalized = if normalized.starts_with("//") {
        format!("https:{normalized}")
    } else if let Some(tail) = normalized.strip_prefix("http://") {
        format!("https://{tail}")
    } else {
        normalized
    };
    let url = Url::parse(&normalized).ok()?;
    if !allowed_source_url(&url) {
        return None;
    }
    Some(url)
}

fn source(name: &str, entity_id: &str, title: String, image: Url, publisher: Url) -> Source {
    Source {
        title,
        thumb_url: image.to_string(),
        image_url: image.to_string(),
        source_url: publisher.to_string(),
        artist: "新浪娱乐".into(),
        license: "来源页未标注许可，仅作人物参考".into(),
        license_url: None,
        entity_id: entity_id.into(),
        person_name: name.into(),
        provider: Some("Sogou/Sina".into()),
    }
}

fn verified(
    html: &str,
    candidate: &Candidate,
    name: &str,
    entity_id: &str,
    context: &str,
) -> Vec<Source> {
    if let Some(gallery) = assigned_json(html, "var slide_data") {
        return gallery["images"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|image| {
                let title = image["title"].as_str()?;
                let intro = image["intro"].as_str()?;
                if !title.contains(name)
                    || group(title)
                    || group(intro)
                    || !identity(intro, name, context)
                {
                    return None;
                }
                let url = normalize_url(image["image_url"].as_str()?, true)?;
                Some(source(
                    name,
                    entity_id,
                    title.into(),
                    url,
                    candidate.source.clone(),
                ))
            })
            .take(4)
            .collect();
    }
    // A publisher headline names the depicted person, while the body supplies the role.
    let Some(title) = html
        .split_once("<title>")
        .and_then(|(_, s)| s.split_once("</title>"))
        .map(|(s, _)| plain_text(s))
    else {
        return vec![];
    };
    if !title.contains(name) || group(&title) || !identity(&plain_text(html), name, context) {
        return vec![];
    }
    let srcs = regex::Regex::new(r#"(?i)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']"#).unwrap();
    let bound = srcs
        .captures_iter(html)
        .filter_map(|c| normalize_url(&c[1], true))
        .any(|u| u == candidate.image);
    if !bound {
        return vec![];
    }
    vec![source(
        name,
        entity_id,
        candidate.title.clone(),
        candidate.image.clone(),
        candidate.source.clone(),
    )]
}

pub(crate) async fn search(
    _client: reqwest::Client,
    name: String,
    entity_id: String,
    context: String,
) -> Vec<Source> {
    let work = async {
        let Ok(client) = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(super::public_figures::USER_AGENT)
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(3))
            .build()
        else {
            return vec![];
        };
        let mut url = Url::parse("https://pic.sogou.com/pics").unwrap();
        let context: String = context.chars().take(80).collect();
        let mut seen = HashSet::new();
        let role =
            if context.contains("歌手") || context.contains("超级女声") || context.contains("超女")
            {
                Some("歌手")
            } else if context.contains("演员") || context.contains("演員") {
                Some("演员")
            } else if context.contains("运动员") || context.contains("運動員") {
                Some("运动员")
            } else {
                None
            };
        let mut found = Vec::new();
        let queries =
            std::iter::once(name.clone()).chain(role.map(|role| format!("{name} {role}")));
        for query in queries {
            url.set_query(None);
            url.query_pairs_mut().append_pair("query", &query);
            if let Some(html) = page(&client, url.clone()).await {
                found.extend(candidates(&html, &name));
            }
        }
        let candidates: Vec<_> = found
            .into_iter()
            .filter(|c| seen.insert(format!("{}#{}", c.source, c.image)))
            .take(6)
            .collect();
        let mut results = Vec::new();
        for batch in candidates.chunks(3) {
            let mut tasks = tokio::task::JoinSet::new();
            for candidate in batch {
                let (client, candidate, name, entity_id, context) = (
                    client.clone(),
                    candidate.clone(),
                    name.clone(),
                    entity_id.clone(),
                    context.clone(),
                );
                tasks.spawn(async move {
                    page(&client, candidate.source.clone())
                        .await
                        .map(|html| verified(&html, &candidate, &name, &entity_id, &context))
                        .unwrap_or_default()
                });
            }
            while let Some(result) = tasks.join_next().await {
                if let Ok(sources) = result {
                    results.extend(sources);
                }
            }
            if results.len() >= 4 {
                break;
            }
        }
        let mut images = HashSet::new();
        results
            .into_iter()
            .filter(|s| images.insert(s.image_url.clone()))
            .take(4)
            .collect()
    };
    tokio::time::timeout(Duration::from_secs(10), work)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> Candidate {
        Candidate {
            title: "超女厉娜演唱".into(),
            image: Url::parse("https://image2.sina.com.cn/test.jpg").unwrap(),
            source: Url::parse("https://ent.sina.com.cn/story.html").unwrap(),
        }
    }

    #[test]
    fn discovery_parses_json_escapes_and_rejects_wrong_hosts() {
        let html = r#"<script>window.__INITIAL_STATE__={"searchList":{"searchList":[{"title":"\u5389\u5a1c超女","oriPicUrl":"http:\/\/image2.sina.com.cn/test.jpg","url":"http://ent.sina.com.cn/story.html"},{"title":"厉娜合影","oriPicUrl":"https://image2.sina.com.cn/x.jpg","url":"https://ent.sina.com.cn/x"},{"title":"厉娜超女","oriPicUrl":"https://image2.sina.com.cn.evil.test/x.jpg","url":"https://ent.sina.com.cn/x"}]}};</script>"#;
        let rows = candidates(html, "厉娜");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].image.as_str(),
            "https://image2.sina.com.cn/test.jpg"
        );
        assert!(assigned_json(
            "window.__INITIAL_STATE__=alert(1)",
            "window.__INITIAL_STATE__"
        )
        .is_none());
    }

    #[test]
    fn publisher_requires_named_role_and_exact_img_binding() {
        let html = r#"<title>超女厉娜演唱</title><p>厉娜参加2006超级女声</p><img src="http://image2.sina.com.cn/test.jpg">"#;
        assert_eq!(
            verified(html, &candidate(), "厉娜", "Q1", "超级女声").len(),
            1
        );
        assert!(verified(
            &html.replace("test.jpg", "other.jpg"),
            &candidate(),
            "厉娜",
            "Q1",
            "超级女声"
        )
        .is_empty());
        assert!(verified(
            &html
                .replace("2006超级女声", "运动员")
                .replace("超女", "体育"),
            &candidate(),
            "厉娜",
            "Q1",
            "超级女声"
        )
        .is_empty());
    }

    #[test]
    fn gallery_binds_each_caption_and_rejects_other_people_or_groups() {
        let html = r#"var slide_data={"images":[{"title":"许飞写真","intro":"歌手许飞曝光早春写真","image_url":"//www.sinaimg.cn/a.jpg"},{"title":"其他演员","intro":"歌手许飞报道中的演员","image_url":"//www.sinaimg.cn/b.jpg"},{"title":"许飞合照","intro":"歌手许飞","image_url":"//www.sinaimg.cn/c.jpg"}]};"#;
        let rows = verified(html, &candidate(), "许飞", "Q2", "歌手");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].image_url, "https://www.sinaimg.cn/a.jpg");
    }

    #[test]
    fn allowlists_reject_credentials_ports_and_host_suffix_attacks() {
        for raw in [
            "http://www.sinaimg.cn/a",
            "https://www.sinaimg.cn.evil.test/a",
            "https://u@www.sinaimg.cn/a",
            "https://www.sinaimg.cn:444/a",
            "https://www.sinaimg.cn/a#x",
        ] {
            assert!(!allowed_image_url(&Url::parse(raw).unwrap()));
        }
    }

    #[tokio::test]
    async fn bounded_legacy_body_uses_explicit_gbk_decoder() {
        let body = vec![0xc0, 0xf7, 0xc4, 0xc8]; // 厉娜 in GBK, invalid as UTF-8.
        assert!(std::str::from_utf8(&body).is_err());
        let response = reqwest::Response::from(axum::http::Response::new(body));
        assert_eq!(response.text_with_charset("gbk").await.unwrap(), "厉娜");
    }
}
