use crate::*;

pub fn valid_params(mut p: Value) -> Result<Value> {
    if !p.is_object() {
        return Err(fail("参数格式无效"));
    }
    for key in ["compare", "supportsFaceSwap"] {
        if !p[key].is_null() && !p[key].is_boolean() {
            return Err(fail("生成开关无效"));
        }
    }
    if p["supportsFaceSwap"] == true {
        p["mode"] = json!(
            if p["references"].as_array().is_some_and(|r| !r.is_empty()) {
                "edit"
            } else {
                "reference"
            }
        );
        if strv(&p, "faceSwapPrompt").trim().is_empty() {
            p["faceSwapPrompt"]=json!("上传照片是人物身份唯一依据，保持脸型、五官、肤色、发型与身份一致；替换案例人物，其他画面遵照基础提示词。");
        }
    }
    if strv(&p, "prompt").trim().is_empty() || strv(&p, "prompt").chars().count() > 12000 {
        return Err(fail("请输入画面提示词（最多12000字）"));
    }
    for (k, max) in [("text", 1500), ("faceSwapPrompt", 4000)] {
        if !p[k].is_null() && (!p[k].is_string() || strv(&p, k).chars().count() > max) {
            return Err(fail("文字长度或格式无效"));
        }
    }
    if !store::SIZES.contains(&strv(&p, "size")) || !store::QUALITIES.contains(&strv(&p, "quality"))
    {
        return Err(fail("请选择支持的画幅与质量"));
    }
    if !["reference", "blend", "edit"].contains(&strv(&p, "mode")) {
        return Err(fail("图片用途无效"));
    }
    let refs = p["references"]
        .as_array()
        .ok_or_else(|| fail("参考图格式无效"))?;
    if refs.len() > 4 {
        return Err(fail("最多上传4张参考图"));
    }
    for r in refs {
        decode_image(r.as_str().unwrap_or(""), 10 * 1024 * 1024)?;
    }
    if p["mode"] == "edit" && refs.is_empty() {
        return Err(fail("修改原图需要先上传图片"));
    }
    let annotations = p.get("annotations").cloned().unwrap_or(json!([]));
    let list = annotations.as_array().ok_or_else(|| fail("标记格式无效"))?;
    if list.len() > 12 {
        return Err(fail("最多保留12条局部修改"));
    }
    if !list.is_empty() && p["mode"] != "edit" {
        return Err(fail("局部修改须使用修改原图模式"));
    }
    for a in list {
        if !["point", "box"].contains(&strv(a, "type"))
            || strv(a, "text").trim().is_empty()
            || strv(a, "text").chars().count() > 500
        {
            return Err(fail("请填写每个标记的修改要求"));
        }
        for k in if a["type"] == "box" {
            vec!["x", "y", "w", "h"]
        } else {
            vec!["x", "y"]
        } {
            if !a[k].as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)) {
                return Err(fail("标记位置无效"));
            }
        }
        if a["type"] == "box"
            && (a["w"].as_f64().unwrap() == 0.0
                || a["h"].as_f64().unwrap() == 0.0
                || a["x"].as_f64().unwrap() + a["w"].as_f64().unwrap() > 1.001
                || a["y"].as_f64().unwrap() + a["h"].as_f64().unwrap() > 1.001)
        {
            return Err(fail("框选范围无效"));
        }
    }
    if !p["mask"].is_null() && p["mask"] != "" {
        let (m, mime) = decode_image(strv(&p, "mask"), 10 * 1024 * 1024)?;
        if p["mode"] != "edit" || mime != "image/png" {
            return Err(fail("蒙版须为PNG且处于编辑模式"));
        }
        let (r, _) = decode_image(refs[0].as_str().unwrap(), 10 * 1024 * 1024)?;
        let mi = image::load_from_memory(&m).map_err(|_| fail("蒙版无效"))?;
        let ri = image::load_from_memory(&r).map_err(|_| fail("原图无效"))?;
        if mi.width() != ri.width() || mi.height() != ri.height() || !mi.color().has_alpha() {
            return Err(fail("蒙版须有透明通道并与原图尺寸一致"));
        }
    }
    p["prompt"] = json!(strv(&p, "prompt").trim());
    p["annotations"] = annotations;
    p["count"] = json!(image_workbench_core::image_count(
        if p["mode"] == "edit" {
            image_workbench_core::Intent::Edit
        } else {
            image_workbench_core::Intent::Create
        },
        p["compare"] == true
    ));
    Ok(p)
}
pub fn decode_image(s: &str, max: usize) -> Result<(Vec<u8>, String)> {
    if s.len() > max * 4 / 3 + 100 {
        return Err(fail("图片过大"));
    }
    let (head, content) = s.split_once(',').ok_or_else(|| fail("图片格式无效"))?;
    let mime = head
        .strip_prefix("data:")
        .and_then(|s| s.strip_suffix(";base64"))
        .filter(|s| ["image/png", "image/jpeg", "image/webp"].contains(s))
        .ok_or_else(|| fail("图片格式无效"))?;
    let bytes = STANDARD.decode(content).map_err(|_| fail("图片内容无效"))?;
    if bytes.len() > max || store::image_type(&bytes)? != mime {
        return Err(fail("图片内容或大小无效"));
    }
    Ok((bytes, mime.to_owned()))
}
#[allow(clippy::type_complexity)]
pub fn video_job(db: &impl repositories::database::Query, job: &str) -> Result<Value> {
    let (
        account,
        status,
        phase,
        created,
        prompt,
        duration,
        ratio,
        resolution,
        url,
        error,
        reserved,
        charged,
        provider,
        started,
    ): (
        String,
        String,
        String,
        i64,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        i64,
        Option<String>,
        Option<i64>,
    ) = db.query_row(
        repositories::statements::generation::SELECT_VIDEO_JOBS_ID,
        [job],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
                r.get(11)?,
                r.get(12)?,
                r.get(13)?,
            ))
        },
    )?;
    let progress = if status == "done" {
        100
    } else if status == "running" {
        started
            .map(|s| {
                (((now() - s).max(0) as f64 / (duration * 60_000) as f64) * 95.0).floor() as i64
            })
            .unwrap_or(1)
            .clamp(1, 95)
    } else {
        0
    };
    Ok(
        json!({"id":job,"status":status,"phase":phase,"created":created,"prompt":prompt,"duration":duration,"ratio":ratio,"resolution":resolution,"url":url,"error":error.unwrap_or_default(),"reservedCents":reserved,"chargedCents":charged,"providerId":provider,"progress":progress,"estimatedSeconds":duration*60,"elapsedSeconds":started.map(|s|(now()-s).max(0)/1000).unwrap_or(0),"availableCents":store::money(db)?["availableCents"],"account":account}),
    )
}
