//! Explicit visual direction and deterministic, non-billable prompt preparation.
use crate::{strv, Error, Result};
use serde_json::Value;

pub const STYLES: [&str; 9] = [
    "auto",
    "monochrome-anime",
    "pixar",
    "realistic",
    "clay",
    "chinese-aesthetic",
    "shanghai-animation",
    "cel",
    "custom",
];
pub const QUALITY_MARK: &str = "\n\n【生成质量规范】\n";

pub fn validate(style: &str, detail: &str) -> Result<()> {
    if !STYLES.contains(&style)
        || detail.chars().count() > 120
        || (style == "custom" && detail.trim().is_empty())
    {
        return Err(Error(400, "视频画风无效，自定义画风须为1至120字".into()));
    }
    Ok(())
}

pub fn detect(text: &str) -> Option<&'static str> {
    // Keep the most recent explicit direction, rather than an earlier draft.
    [
        ("黑白动漫", "monochrome-anime"),
        ("黑白漫画", "monochrome-anime"),
        ("皮克斯", "pixar"),
        ("Pixar", "pixar"),
        ("真人", "realistic"),
        ("写实", "realistic"),
        ("实拍", "realistic"),
        ("黏土", "clay"),
        ("粘土", "clay"),
        ("中式美学", "chinese-aesthetic"),
        ("水墨", "chinese-aesthetic"),
        ("上海美术", "shanghai-animation"),
        ("上美影", "shanghai-animation"),
        ("赛璐璐", "cel"),
    ]
    .iter()
    .flat_map(|(word, style)| {
        text.match_indices(word).filter_map(move |(at, _)| {
            let prefix = text[..at]
                .rsplit(['，', '。', ',', ';', '；'])
                .next()
                .unwrap_or("")
                .trim();
            let denied = ["不要", "不用", "不是", "避免", "不采用", "不使用", "非"]
                .iter()
                .any(|negation| prefix.ends_with(negation));
            (!denied).then_some((at, *style))
        })
    })
    .max_by_key(|(at, _)| *at)
    .map(|(_, style)| style)
}

pub fn direction(style: &str) -> &'static str {
    match style {
        "monochrome-anime" => "黑白动漫：黑白灰层次、清晰墨线、网点与稳定角色轮廓，控制高光，不混入真人皮肤摄影。",
        "pixar" => "皮克斯风格的三维角色动画：圆润造型、细腻材质、柔和全局光照、富有表现力的眼神，保持卡通比例和角色一致。",
        "realistic" => "真人短剧实拍质感：自然肤色与细微皮肤纹理，保留适度毛孔和自然瑕疵，柔和方向光、真实明暗过渡和克制高光，稳定五官、自然微表情；避免油画笔触、蜡质磨皮、塑料光泽和过度锐化。",
        "clay" => "黏土定格动画：手工揉捏指纹、哑光黏土材质、微缩布景和克制定格节奏，保持角色体积与材质一致。",
        "chinese-aesthetic" => "中式美学动画：东方留白、含蓄配色、山水层次和舒展线条，材质与笔触前后一致，动作自然连贯。",
        "shanghai-animation" => "上海美术电影制片厂经典动画美学：民族装饰造型、手绘色块、富有韵律的线条和诗意构图，保持统一手绘材质。",
        "cel" => "赛璐璐动画：干净轮廓、平涂色块、明确分层阴影、稳定线稿，保持色彩和角色造型连贯。",
        _ => "遵循本次用户明确指定的画风、笔触和材质，不擅自替换风格。",
    }
}

pub fn prepare(prompt: &str, style: &str, detail: &str) -> String {
    let resolved = if style == "auto" {
        detect(prompt).unwrap_or("auto")
    } else {
        style
    };
    let custom = if detail.is_empty() {
        String::new()
    } else {
        format!("用户画风要求：{detail}。")
    };
    format!("{prompt}{QUALITY_MARK}{}{custom}保持主体身份、服装、场景和光线连续；动作按分镜依次完成，运镜稳定，减少不必要的快速切镜和突变；保留用户对白、文字和否定约束。不要把分镜表、文字说明或水印画进画面。", direction(resolved))
}

pub fn input_style(input: &Value) -> Result<(&str, &str)> {
    let style = input
        .get("style")
        .map(|_| strv(input, "style"))
        .unwrap_or("auto");
    let detail = strv(input, "stylePrompt").trim();
    validate(style, detail)?;
    Ok((style, detail))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skin_quality_is_specific_to_live_action() {
        let real = prepare("女孩转头", "realistic", "");
        assert!(real.contains("毛孔") && real.contains("油画笔触") && real.contains("女孩转头"));
        let clay = prepare("女孩转头", "clay", "");
        assert!(clay.contains("指纹") && !clay.contains("毛孔"));
        assert_eq!(detect("先真人，改为赛璐璐"), Some("cel"));
        assert_eq!(detect("真人短剧，不要黏土风格"), Some("realistic"));
        assert_eq!(detect("黏土动画，不要真人"), Some("clay"));
        assert!(!prepare("人物", "custom", "油画风格").contains("不擅自替换风格或加入油画笔触"));
        assert!(validate("custom", "").is_err());
        assert!(validate("invalid", "").is_err());
        assert!(prepare("油画人物", "auto", "").contains("遵循本次用户明确指定的画风"));
    }
}
