//! Conservative GIF recommendations, based on measured provider output.
//! These are production defaults, not claims about the model's hard limits.
use crate::{fail, Result};
use serde_json::{json, Value};

fn number(text: &str) -> Option<f64> {
    if let Ok(value) = text.parse() {
        return Some(value);
    }
    let digit = |c| {
        "零一二三四五六七八九"
            .chars()
            .position(|n| n == c)
            .map(|n| n as f64)
    };
    if text == "两" {
        return Some(2.);
    }
    if let Some((tens, units)) = text.split_once('十') {
        return Some(
            if tens.is_empty() {
                1.
            } else {
                digit(tens.chars().next()?)?
            } * 10.
                + if units.is_empty() {
                    0.
                } else {
                    digit(units.chars().next()?)?
                },
        );
    }
    if text.chars().count() == 1 {
        digit(text.chars().next()?)
    } else {
        None
    }
}

pub fn explicitly_static(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    let prompt = regex::Regex::new(r"(?:不要|不需要|不生成|无需|不用)\s*静态(?:图片|图|画面)?")
        .unwrap()
        .replace_all(&prompt, "");
    regex::Regex::new(r"(?:不要|无需|不需要|不用|不生成|取消)\s*(?:gif(?:\s*动图)?(?:[^a-z]|$)|动图|动画)|(?:改为|改成|只要|仅要|生成|一张)\s*静态(?:图|图片|画面)?")
        .unwrap().is_match(&prompt)
}

fn settings(duration: f64, fps: f64) -> Value {
    let seconds = duration.round().clamp(1., 6.) as u64;
    let mut notice =
        "推荐 4 帧/秒、总帧数不超过 24 帧；实际格式、帧数和时长以生成结果为准。".to_owned();
    if (duration - seconds as f64).abs() > f64::EPSILON || fps != 4. {
        notice = format!("已将请求优化为 4 帧/秒、{seconds} 秒、共 {} 帧，以控制动图质量；实际结果仍可能有偏差。", seconds * 4);
    }
    json!({"fps":4,"durationSeconds":seconds,"frames":seconds * 4,"notice":notice})
}

pub fn recommend(prompt: &str) -> Option<Value> {
    if explicitly_static(prompt)
        || !regex::Regex::new(
            r"(?i)(?:^|[^a-z])gif(?:$|[^a-z])|动图|循环动画|(?:生成|制作|做)(?:一段|一个)?动画",
        )
        .unwrap()
        .is_match(prompt)
    {
        return None;
    }
    let numeric = r"([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]+)";
    let duration_pattern = format!(r"(?i){numeric}\s*(?:秒|seconds?\b|secs?\b|s\b)");
    let duration = regex::Regex::new(&duration_pattern)
        .unwrap()
        .captures(prompt)
        .and_then(|c| number(&c[1]))
        .filter(|n| n.is_finite() && *n > 0.)
        .unwrap_or(3.);
    let fps_pattern = format!(r"(?i)(?:每秒\s*{numeric}\s*帧|{numeric}\s*(?:fps|帧\s*/\s*秒))");
    let fps = regex::Regex::new(&fps_pattern)
        .unwrap()
        .captures(prompt)
        .and_then(|c| c.get(1).or_else(|| c.get(2)))
        .and_then(|m| number(m.as_str()))
        .unwrap_or(4.);
    Some(settings(duration, fps))
}

/// The browser cannot choose unbounded frame counts or supply trusted notices.
pub fn normalize(value: &Value, prompt: &str) -> Result<Option<Value>> {
    if value.is_null() {
        return Ok(recommend(prompt));
    }
    if !value.is_object() {
        return Err(fail("动图参数格式无效"));
    }
    if !value["notice"].is_null()
        && !value["notice"]
            .as_str()
            .is_some_and(|notice| notice.chars().count() <= 500)
    {
        return Err(fail("动图参数说明无效"));
    }
    let fps = value["fps"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0. && *n <= 1000.)
        .ok_or_else(|| fail("动图帧率参数无效"))?;
    let duration = value["durationSeconds"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0. && *n <= 3600.)
        .ok_or_else(|| fail("动图时长参数无效"))?;
    if !value["frames"].is_null() && value["frames"].as_u64().filter(|n| *n > 0).is_none() {
        return Err(fail("动图帧数参数无效"));
    }
    if explicitly_static(prompt) {
        return Err(fail("静态图片描述与动图参数冲突，请重新确认方案"));
    }
    let mut normalized = settings(duration, fps);
    if let Some(original) = recommend(prompt) {
        if original["durationSeconds"] == normalized["durationSeconds"]
            && original["notice"]
                .as_str()
                .unwrap_or("")
                .contains("已将请求优化")
        {
            normalized["notice"] = original["notice"].clone();
        }
    }
    Ok(Some(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_chinese_duration() {
        assert_eq!(recommend("猫咪 GIF 动图").unwrap()["frames"], 12);
        let plan = recommend("循环动画，每秒八帧，三秒钟").unwrap();
        assert_eq!(plan["fps"], 4);
        assert_eq!(plan["durationSeconds"], 3);
        assert!(plan["notice"].as_str().unwrap().contains("已将请求优化"));
        assert_eq!(recommend("GIF 15秒 32fps").unwrap()["frames"], 24);
        assert_eq!(recommend("GIF 0.5秒").unwrap()["durationSeconds"], 1);
    }
    #[test]
    fn respects_static_and_negative_intent() {
        for text in [
            "不要动图，画猫咪",
            "不需要 GIF",
            "改成静态图",
            "静态海报",
            "A gift box on a wooden table",
            "Christmas gifts",
            "动画风格插画",
            "阿德曼动画风格",
        ] {
            assert!(recommend(text).is_none(), "{text}");
        }
        assert!(recommend("不要静态图，要GIF动图").is_some());
        assert!(recommend("不要gift标签，要GIF动图").is_some());
        assert!(recommend("不生成静态图，生成GIF").is_some());
        assert_eq!(recommend("GIF 5 SECONDS").unwrap()["durationSeconds"], 5);
    }
    #[test]
    fn normalizes_untrusted_submission() {
        let value = normalize(
            &json!({"fps":50,"durationSeconds":15,"frames":999}),
            "循环 GIF",
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["frames"], 24);
        assert!(
            normalize(&json!({"fps":4,"durationSeconds":6}), "GIF 15秒 32fps")
                .unwrap()
                .unwrap()["notice"]
                .as_str()
                .unwrap()
                .contains("已将请求优化")
        );
        for input in [
            json!(true),
            json!({"fps":0,"durationSeconds":3}),
            json!({"fps":4,"durationSeconds":"3"}),
            json!({"fps":4,"durationSeconds":3,"frames":-1}),
        ] {
            assert!(normalize(&input, "GIF").is_err());
        }
        assert!(normalize(&json!({"fps":4,"durationSeconds":3}), "只要静态图").is_err());
        assert!(normalize(&Value::Null, "普通插画").unwrap().is_none());
    }
}
