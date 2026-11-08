//! Server-owned duration policy and validation for video conversational plans.
//! This module only returns a plan; generation remains a separate confirmed POST.
use crate::{strv, Error, Result};
use serde_json::{json, Value};
use std::sync::LazyLock;

pub const SYSTEM: &str = "你是「剑来」的视频分镜创作助手。根据本次明确需求与对话上下文，整理一条完整视频的连续分镜，不生成视频、不调用工具、不声称已扣费。保留用户主体、文字、否定限制和风格；有首帧时保持主体身份与视觉连贯。先用1至2句中文说明优化，然后换行输出 <<<PLAN>>> 和一个JSON对象，之后不再输出文字。JSON字段：duration为服务端指定的总秒数，ratio为16:9、9:16、1:1、4:3、3:4、21:9之一，resolution为768P或2K，shots为1至6个镜头的数组。每个镜头含duration（正整数秒）、scene（具体画面，不超过200字）、camera（运镜和衔接，不超过80字）。镜头时长之和必须等于总时长。用不同镜头推进事件，不重复同一句描述。全部scene和camera连同时间标记拼接后不得超过2000字。默认10秒；用户要求超过15秒时明确单次最多生成15秒，并压缩事件、保留关键内容优化成15秒。少于4秒时优化成4秒。不擅自拆成多个收费任务，不承诺逐帧精确剪辑点。用户续聊时修改当前草案；如果只是问问题可简短回答，不输出计划。";
pub const RATIOS: [&str; 6] = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

#[derive(Clone, Debug)]
pub struct Policy {
    pub duration: u32,
    pub notice: Option<&'static str>,
    ratio: String,
    resolution: String,
}

fn chinese_number(text: &str) -> Option<f64> {
    if text == "半" {
        return Some(0.5);
    }
    if let Ok(value) = text.parse::<f64>() {
        return value.is_finite().then_some(value);
    }
    let mut total = 0u32;
    let mut section = 0u32;
    let mut digit = 0u32;
    for c in text.chars() {
        match c {
            '零' | '〇' => digit = 0,
            '一' => digit = 1,
            '二' | '两' => digit = 2,
            '三' => digit = 3,
            '四' => digit = 4,
            '五' => digit = 5,
            '六' => digit = 6,
            '七' => digit = 7,
            '八' => digit = 8,
            '九' => digit = 9,
            '十' => {
                section += digit.max(1) * 10;
                digit = 0;
            }
            '百' => {
                section += digit.max(1) * 100;
                digit = 0;
            }
            '千' => {
                section += digit.max(1) * 1000;
                digit = 0;
            }
            '万' => {
                total += (section + digit).max(1) * 10_000;
                section = 0;
                digit = 0;
            }
            _ => return None,
        }
    }
    Some(f64::from(total + section + digit))
}

/// Parse a requested running time, not a bare number, aspect ratio or resolution.
/// Adjacent mixed units (1 minute 30 seconds) represent one duration.
fn requested_seconds(text: &str) -> Option<f64> {
    static DURATION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"(?i)([0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*(小时|分钟|秒钟|seconds?(?-u:\b)|secs?(?-u:\b)|minutes?(?-u:\b)|mins?(?-u:\b)|hours?(?-u:\b)|秒|分|s(?-u:\b)|m(?-u:\b)|h(?-u:\b))"
    ).expect("static duration expression")
    });
    let matches: Vec<_> = DURATION.captures_iter(text).collect();
    // A per-shot revision is not a new total duration. Explicit total wording
    // remains authoritative, otherwise keep the current approved duration.
    let explicit_total = [
        "总时长",
        "总共",
        "一共",
        "全片",
        "视频时长",
        "total",
        "overall",
    ]
    .iter()
    .filter_map(|word| text.rfind(word))
    .max();
    static PER_SHOT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:第[0-9零〇一二两三四五六七八九十]+个?镜头|镜头\s*[0-9零〇一二两三四五六七八九十]+)").expect("static shot expression")
    });
    if explicit_total.is_none()
        && PER_SHOT.is_match(text)
        && ["改", "调整", "保留"]
            .iter()
            .any(|word| text.contains(word))
    {
        return None;
    }
    // A correction's target wins over its rejected/source duration.
    let correction = [
        "改为",
        "改成",
        "缩短到",
        "缩短至",
        "延长到",
        "延长至",
        "换成",
        "而是",
    ]
    .iter()
    .filter_map(|word| text.rfind(word).map(|index| index + word.len()))
    .max();
    let after = explicit_total.unwrap_or(0).max(correction.unwrap_or(0));
    let eligible: Vec<_> = matches
        .iter()
        .filter(|m| {
            m.get(0).is_some_and(|v| {
                v.start() >= after
                    && !["不要", "别用", "不是"]
                        .iter()
                        .any(|word| text[..v.start()].trim_end().ends_with(word))
            })
        })
        .collect();
    let first = *eligible.first()?;
    // A standalone running-time requirement is a single quantity. Only
    // accumulate adjacent components of a mixed-unit duration.
    let mut end = first.get(0)?.end();
    let mut captures = vec![first];
    for found in eligible.iter().skip(1) {
        let span = found.get(0)?;
        if !text[end..span.start()].trim().is_empty() {
            break;
        }
        captures.push(*found);
        end = span.end();
    }
    let mut total = 0.0;
    for item in captures {
        let amount = chinese_number(item.get(1)?.as_str())?;
        let unit = item.get(2)?.as_str().to_lowercase();
        let factor = if unit.starts_with('h') || unit == "小时" {
            3600.0
        } else if unit.starts_with('m') || unit == "分钟" || unit == "分" {
            60.0
        } else {
            1.0
        };
        total += amount * factor;
    }
    if text.contains("分半") {
        total += 30.0;
    }
    (total.is_finite() && total >= 0.0).then_some(total)
}

pub fn policy(input: &Value) -> Result<Policy> {
    let latest = input["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|m| strv(m, "role") == "user"))
        .map(|m| strv(m, "content"))
        .unwrap_or_default();
    let duration = requested_seconds(latest).unwrap_or_else(|| {
        input["video"]["duration"]
            .as_u64()
            .filter(|d| (4..=15).contains(d))
            .unwrap_or(10) as f64
    });
    let notice = if duration > 15.0 {
        Some("最多一次性生成 15 秒的画面，已将内容压缩优化为 15 秒分镜，请确认后再生成。")
    } else if duration < 4.0 {
        Some("单次视频最短为 4 秒，已优化为 4 秒分镜，请确认后再生成。")
    } else {
        None
    };
    let ratio = strv(&input["video"], "ratio");
    let resolution = strv(&input["video"], "resolution");
    if !ratio.is_empty() && !RATIOS.contains(&ratio) {
        return Err(Error(400, "视频画幅无效".into()));
    }
    if !resolution.is_empty() && !["768P", "2K"].contains(&resolution) {
        return Err(Error(400, "视频清晰度无效".into()));
    }
    Ok(Policy {
        duration: duration.round().clamp(4.0, 15.0) as u32,
        notice,
        ratio: if ratio.is_empty() { "16:9" } else { ratio }.into(),
        resolution: if resolution.is_empty() {
            "768P"
        } else {
            resolution
        }
        .into(),
    })
}

impl Policy {
    pub fn context(&self) -> String {
        format!(
            "本次总时长固定为{}秒，默认画幅{}，默认清晰度{}。所有镜头duration之和必须为{}。{}",
            self.duration,
            self.ratio,
            self.resolution,
            self.duration,
            self.notice.unwrap_or("")
        )
    }
}

/// Timing may be proportionally normalized, but scene text is never fabricated.
/// Malformed plans remain errors rather than a fake valid storyboard.
pub fn parse(raw: &str, policy: &Policy) -> Option<Value> {
    let raw = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: Value = serde_json::from_str(raw).ok()?;
    let shots = value["shots"].as_array()?;
    if shots.is_empty() || shots.len() > 6 || shots.len() > policy.duration as usize {
        return None;
    }
    value["duration"]
        .as_u64()
        .filter(|n| (1..=3600).contains(n))?;
    let ratio = value["ratio"].as_str().unwrap_or(&policy.ratio);
    let resolution = value["resolution"].as_str().unwrap_or(&policy.resolution);
    if !RATIOS.contains(&ratio) || !["768P", "2K"].contains(&resolution) {
        return None;
    }
    let mut weights = Vec::with_capacity(shots.len());
    let mut content = Vec::with_capacity(shots.len());
    let mut chars = 0;
    for shot in shots {
        let duration = shot["duration"]
            .as_u64()
            .filter(|n| (1..=3600).contains(n))?;
        let scene = strv(shot, "scene").trim();
        let camera = strv(shot, "camera").trim();
        if scene.is_empty()
            || scene.chars().count() > 200
            || camera.is_empty()
            || camera.chars().count() > 80
        {
            return None;
        }
        chars += scene.chars().count() + camera.chars().count() + 40;
        if chars > 1900 {
            return None;
        }
        weights.push(duration);
        content.push((scene, camera));
    }
    let sum: u64 = weights.iter().sum();
    let duration = u64::from(policy.duration);
    let timings = if sum == duration {
        weights.clone()
    } else {
        // One second minimum for each shot; distribute remaining seconds by
        // largest remainder, preserving shot order and exact total time.
        let remaining = duration - shots.len() as u64;
        let mut timings: Vec<u64> = weights
            .iter()
            .map(|weight| 1 + remaining * weight / sum)
            .collect();
        let mut remainders: Vec<_> = weights
            .iter()
            .enumerate()
            .map(|(i, weight)| (i, remaining * weight % sum))
            .collect();
        remainders.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let missing = duration - timings.iter().sum::<u64>();
        for (i, _) in remainders.into_iter().take(missing as usize) {
            timings[i] += 1;
        }
        timings
    };
    let result: Vec<_> = content.into_iter().zip(timings).map(|((scene, camera), duration)| json!({"duration":duration,"scene":scene,"camera":camera})).collect();
    let mut result =
        json!({"duration":policy.duration,"ratio":ratio,"resolution":resolution,"shots":result});
    if let Some(notice) = policy.notice {
        result["notice"] = json!(notice);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(text: &str) -> Value {
        json!({"mode":"video","messages":[{"role":"user","content":text}]})
    }
    fn plan(duration: u32) -> Value {
        json!({"duration":duration,"ratio":"16:9","resolution":"768P","shots":[{"duration":2,"scene":"雨滴从屋檐落下","camera":"低机位推进"},{"duration":3,"scene":"街灯倒映在水面","camera":"缓慢抬起"}]})
    }
    #[test]
    fn defaults_to_ten_and_clamps_over_limit_with_server_notice() {
        assert_eq!(policy(&input("雨后的城市短片")).unwrap().duration, 10);
        for text in [
            "拍一个20秒视频",
            "二十秒的雨夜",
            "1 minute video",
            "一分钟三十秒",
            "半分钟短片",
            "一分半的短片",
            "0.5 minutes",
        ] {
            let p = policy(&input(text)).unwrap();
            assert_eq!(p.duration, 15, "{text}");
            assert!(p.notice.unwrap().contains("最多一次性生成 15 秒"));
        }
        assert_eq!(policy(&input("做一个十五秒的视频")).unwrap().duration, 15);
        assert_eq!(policy(&input("做一个十秒视频")).unwrap().duration, 10);
        assert_eq!(policy(&input("做10s的视频")).unwrap().duration, 10);
        let long_shot = policy(&input("做个20秒的长镜头")).unwrap();
        assert_eq!(long_shot.duration, 15);
        assert!(long_shot.notice.is_some());
        assert_eq!(
            policy(&input("全片总时长8秒，镜头1用2秒"))
                .unwrap()
                .duration,
            8
        );
        assert!(policy(&input("2秒短片"))
            .unwrap()
            .notice
            .unwrap()
            .contains("4 秒"));
        assert_eq!(policy(&input("2K 16:9 夜景")).unwrap().duration, 10);
        for (text, duration) in [
            ("不要20秒，改为10秒", 10),
            ("从20秒缩短到8秒", 8),
            ("不要20秒，10秒就好", 10),
        ] {
            let corrected = policy(&input(text)).unwrap();
            assert_eq!(corrected.duration, duration, "{text}");
            assert!(corrected.notice.is_none(), "{text}");
        }
    }
    #[test]
    fn per_shot_edits_keep_current_total_and_explicit_total_wins() {
        let mut i = input("第一个镜头改成2秒，第二个镜头保留");
        i["video"] = json!({"duration":12});
        assert_eq!(policy(&i).unwrap().duration, 12);
        i["messages"][0]["content"] = json!("第一个镜头2秒，全片总时长10秒");
        assert_eq!(policy(&i).unwrap().duration, 10);
        i["messages"][0]["content"] = json!("换成暖色调");
        i["video"]["duration"] = json!(99);
        assert_eq!(policy(&i).unwrap().duration, 10);
    }
    #[test]
    fn validates_and_normalizes_timing_without_fabricating_scenes() {
        let p = policy(&input("20秒短片")).unwrap();
        let parsed = parse(&plan(20).to_string(), &p).unwrap();
        assert_eq!(parsed["duration"], 15);
        assert!(parsed["notice"].as_str().unwrap().contains("15 秒"));
        assert_eq!(
            parsed["shots"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["duration"].as_u64().unwrap())
                .sum::<u64>(),
            15
        );
        assert_eq!(parsed["shots"][0]["scene"], "雨滴从屋檐落下");
        let mut v = plan(10);
        v["shots"][0]["duration"] = json!(0);
        assert!(parse(&v.to_string(), &p).is_none());
        v = plan(10);
        v["shots"][0]["scene"] = json!("x".repeat(201));
        assert!(parse(&v.to_string(), &p).is_none());
        v = plan(10);
        v["ratio"] = json!("invalid");
        assert!(parse(&v.to_string(), &p).is_none());
        assert!(parse("not json", &p).is_none());
        assert!(parse("{}", &p).is_none());
        v = plan(10);
        v["shots"] = json!([]);
        assert!(parse(&v.to_string(), &p).is_none());
        v = plan(10);
        v["shots"] = json!((0..7)
            .map(|_| json!({"duration":1,"scene":"场景","camera":"静止"}))
            .collect::<Vec<_>>());
        assert!(parse(&v.to_string(), &p).is_none());
        v = plan(10);
        v["shots"][0]["camera"] = json!("长".repeat(81));
        assert!(parse(&v.to_string(), &p).is_none());
        v = plan(10);
        v["shots"][0]["camera"] = json!("  ");
        assert!(parse(&v.to_string(), &p).is_none());
        v = plan(10);
        v["duration"] = json!(10.5);
        assert!(parse(&v.to_string(), &p).is_none());
    }
}
