// Shared pure ESM: no DOM, filesystem, Node builtins, or input mutation.
export const DEFAULT_FACE_SWAP_PROMPT = '上传参考图是人物身份的唯一依据；将画面人物的脸替换为上传参考人物的脸，不沿用案例人物脸；保持脸型、眉眼、鼻唇比例、五官、年龄段、肤色、体态比例、发型轮廓及可识别配饰一致；同一人物在多视角、多姿态、多分镜中保持同一身份。';
const KEYS = ['subject', 'composition', 'style', 'color', 'typography', 'details', 'negative'];
const LABELS = ['主体', '构图', '风格', '色彩', '文字', '细节', '限制'];
const FALLBACK = [
  '呈现原创人物与用户指定的主题。', '建立清晰的主体、前景与背景关系。',
  '采用统一的视觉语言与精细材质。', '控制主色、辅助色与明暗层级。',
  '仅渲染用户提供的文字，保持层级与对齐清晰。', '保持材质、光影与边缘细节清晰。',
  '不添加未知文字、水印或数据，不生成乱码或错误肢体。',
];
const placeholders = value => [...String(value || '').matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[0]);
const clean = value => String(value || '').replace(/[ \t]+/g, ' ').replace(/\s*([。；])\s*/g, '$1').replace(/[，、]\s*([。；])/g, '$1').replace(/([。；])\1+/g, '$1').trim();
function parsePrompt(prompt) {
  const result = {};
  const headings = [...String(prompt || '').matchAll(/【(主体|构图|风格|色彩|文字|细节|限制)】\s*/g)];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const key = KEYS[LABELS.indexOf(h[1])];
    result[key] = String(prompt).slice(h.index + h[0].length, headings[i + 1]?.index ?? String(prompt).length).trim();
  }
  return result;
}
function stripPhotoRequirements(value, extracted) {
  let text = String(value || '');
  // Replace the smallest known phrase, never drop a sentence containing a technique,
  // layout, or parameter merely because that sentence also mentions a photograph.
  const replace = (pattern, replacement = '') => {
    text = text.replace(pattern, match => {
      extracted.push(match);
      if (replacement) return replacement;
      // Some future model sentences join an identity instruction and a scene with
      // a comma. Keep the independent design tail, including its punctuation.
      const tail = match.match(/[，,]\s*((?:(?:人物|主体|角色)(?:置于|站在|坐在|位于|身穿)|(?:背景|场景|构图|灯光|材质|纸张|主标题|底座|衣服|服装|配饰)(?:为|是|使用|采用|置于)|(?:采用|使用|呈现|设计|制作|绘制|穿着|身穿)|(?:place|wear|render|create|background|lighting|composition|material)\b)[\s\S]*)/i);
      return tail ? tail[1] : '';
    });
  };
  replace(/使用上传照片中的人物为唯一身份依据[，,]?/g);
  replace(/上传参考图是人物身份的唯一依据[；;]?/g);
  replace(/参考上传人物的面部特征，将案例中的主角面部替换为参考人物[；;]?/g);
  replace(/以参考照片为唯一身份依据，保持脸型、眉眼、鼻唇比例、肤色、年龄段、发型轮廓和可识别配饰一致，不保留案例原人物的脸[；;]?/g);
  replace(/替换案例人物原脸，保持脸型、眉眼、鼻唇比例、肤色、年龄段、发型轮廓、体态比例及可识别配饰一致[；;]?/g);
  replace(/必须保留每个人的身份、年龄段、肤色、脸型、眼鼻嘴比例、发型及可识别配饰，不套用陌生人物或默认网红脸，不删减合照人物[。]?/g);
  replace(/不沿用案例人物脸/g);
  replace(/允许材质和角色形态变化，但不能改变身份/g, '允许材质和角色形态变化');
  // Keep original-character consistency; only remove the photograph dependency.
  replace(/所有主要人物脸部都应参考上传人物或按用户指定身份保持一致，不能把案例人物脸直接沿用/g, '不同角色按用户指定设定区分，同一角色在多视角中保持一致');
  replace(/人物脸只作为构图参考，生成时必须替换成参考照片身份，不保留原案例人物的具体脸/g);
  replace(/人物脸与头像必须属于同一参考身份/g, '人物脸与头像属于同一原创人物');
  replace(/人物像同一参考人物的可收藏版本/g, '人物呈现为同一原创角色的可收藏版本');
  replace(/人物脸保持参考身份一致/g, '同一原创人物的脸在画面中保持一致');
  replace(/人物身份由参考照片决定/g);
  replace(/保留原人物轮廓/g, '人物轮廓清晰');
  replace(/面部五官仍按参考照片/g, '面部五官清晰');
  replace(/面部特征按参考照片/g, '面部特征清晰');
  replace(/脸部保留照片识别特征/g, '脸部特征清晰');
  replace(/保持原人物面部特征/g, '面部特征清晰');
  replace(/保留原人的发型与配饰/g, '发型与配饰细节清晰');
  replace(/所有可见人物都保留身份、相对身高与排列顺序/g, '所有人物的相对身高与排列顺序清晰');
  replace(/把上传的人物/g, '把原创人物');
  replace(/上传人物或合照/g, '原创人物或群像');
  replace(/参考人物的/g, '原创人物的');
  replace(/参考人物/g, '原创人物');
  replace(/关键配饰保留原形/g, '关键配饰形状清晰');
  replace(/保留关键脸部识别点/g, '脸部细节清晰');
  replace(/保留独特眉眼和发型配件/g, '呈现独特眉眼和发型配件');
  replace(/保留肤色对应的灰阶与独特五官/g, '以灰阶表现肤色与独特五官');
  replace(/保留可识别的眼、鼻、嘴与发型边界/g, '眼、鼻、嘴与发型边界清晰');
  replace(/、(?:保留身份|换脸一致性|角色换脸|人物换脸|电影感换脸)(?=的视觉语言)/g);
  // The travel journal mixes photo preservation with a reusable two-part layout.
  replace(/使用参考照片，上半保留原照片环境与主体/g, '上半呈现旅行摄影风格的环境与主体');
  replace(/下半根据照片提取九个实际元素/g, '下半围绕旅行主题选取九个场景元素');
  replace(/不发明照片里不存在的标志性地点/g, '地点由用户指定，不虚构真实地点信息');
  replace(/保留原片色彩/g, '采用统一的摄影色彩');
  replace(/照片元素分成前中后三层/g, '场景元素分成前中后三层');
  replace(/根据案例参考图提取主色、辅助色和明暗层级/g, '围绕主题设定主色、辅助色和明暗层级');
  // Future vision output: isolate bounded instruction clauses rather than deleting
  // their surrounding material/scene sentence. Enumeration tails travel with them.
  replace(/(?:以|将|把|使用|根据|按照|参照)?(?:上传的?|用户上传的?|参考)(?:照片|图片|图像|图|人物照片)(?:中|里)?(?:的)?(?:人物)?(?:作为|设为|为|是)(?:人物)?身份(?:的)?(?:唯一)?依据[^。；;\n]*[。；;]?/g);
  replace(/(?:保持|保留|匹配|还原|沿用|遵循)(?:上传|参考)(?:照片|图片|图像|图|人物)(?:中|里)?(?:的)?(?:人物)?(?:五官|面部|身份|脸型|肤色|年龄|发型|配饰|服装|体态)[^。；;\n]*[。；;]?/g);
  replace(/(?:面部|五官|脸型|身份|人物脸|肤色|年龄|发型)(?:特征)?(?:必须|须|应|要|仍)?(?:与|按|依据|来自|由|保持)(?:上传|参考)(?:照片|图片|图像|图|人物)[^。；;\n]*[。；;]?/g);
  replace(/(?:将|把)?(?:案例|原图|画面)(?:中|里)?(?:的)?(?:人物|主角)?(?:的)?(?:面部|脸部|脸)(?:必须)?(?:替换|换成|更换|替换为|替换成)[^。；;\n]*[。；;]?/g);
  replace(/(?:生成时)?(?:必须|应|须)?(?:换脸|替换成参考照片身份)[^。；;\n]*[。；;]?/g);
  replace(/(?:不保留|不得保留|不能沿用|不沿用)(?:原)?(?:案例|参考图)(?:原)?人物(?:的)?(?:具体)?脸[^。；;\n]*[。；;]?/g);
  replace(/(?:use|using)\s+(?:the\s+)?(?:uploaded|reference)\s+(?:photo|image)(?:graph)?\s+as\s+(?:the\s+)?(?:sole|only|unique)\s+identity\s+(?:source|reference)[^.;\n]*[.;]?/gi);
  replace(/(?:preserve|retain|match)\s+(?:the\s+)?(?:uploaded|reference)\s+(?:person'?s?|photo'?s?|image'?s?)\s+(?:identity|face|facial|age|skin|hair)[^.;\n]*[.;]?/gi);
  replace(/(?:replace|swap)\s+(?:the\s+)?(?:subject'?s?|character'?s?|original|case)\s+face[^.;\n]*[.;]?/gi);
  return clean(text).replace(/^[，,；;。]+|[，,；;]+$/g, '').trim();
}
function uniqueSentences(parts) {
  const seen = new Set();
  const result = [];
  for (const part of parts) for (const sentence of String(part || '').split(/[。；;\n]+/)) {
    const s = clean(sentence).replace(/^[，,]+|[，,]+$/g, '');
    if (s && !seen.has(s)) { seen.add(s); result.push(s); }
  }
  return result.join('；') + (result.length ? '。' : '');
}

export function separateFaceSwapTemplate(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return t;
  const enabled = !!(t.requiresImage || t.supportsFaceSwap || (typeof t.faceSwapPrompt === 'string' && t.faceSwapPrompt.trim()));
  if (!enabled) return t;
  const extracted = [];
  const raw = typeof t.prompt === 'string' ? t.prompt : '';
  const parsed = parsePrompt(raw);
  const source = t.promptSections && typeof t.promptSections === 'object' && !Array.isArray(t.promptSections) ? t.promptSections : {};
  const sections = Object.fromEntries(KEYS.map((key, i) => {
    const value = typeof source[key] === 'string' && source[key].trim() ? source[key] : parsed[key] || (key === 'composition' && !Object.keys(parsed).length ? raw : FALLBACK[i]);
    return [key, stripPhotoRequirements(value, extracted) || FALLBACK[i]];
  }));
  // Preserve placeholders even when one was embedded in an extracted identity
  // instruction: they remain editable in the no-photo template and swap module.
  const before = new Set([raw, ...KEYS.map(k => source[k])].flatMap(placeholders));
  const after = new Set(Object.values(sections).flatMap(placeholders));
  const missing = [...before].filter(p => !after.has(p));
  if (missing.length) sections.subject = clean(sections.subject + ' 可编辑参数：' + missing.join('；') + '。');
  const preserveResolvedPrompt = KEYS.every(k => parsed[k] && clean(parsed[k]) === sections[k]) && extracted.length === 0 && missing.length === 0;
  const parameterDefaults = t.parameterDefaults && typeof t.parameterDefaults === 'object' && !Array.isArray(t.parameterDefaults)
    ? Object.fromEntries(Object.entries(t.parameterDefaults).map(([name, value]) => {
      if (typeof value !== 'string') return [name, value];
      let next = value
        .replace(/(?:保留|沿用|按)(?:参考|上传)?照片(?:中|里)?(?:的)?(?:服装|穿着)(?:和|与)?配饰/g, '与人物气质协调的服装和配饰')
        .replace(/(?:保留|沿用|按)(?:参考|上传)?照片(?:中|里)?(?:的)?(?:服装|穿着)(?:轮廓|结构)?/g, '原创角色的服装')
        .replace(/保留照片背景关键元素/g, '围绕主题设计背景关键元素')
        .replace(/保留照片发型和服装识别特征/g, '设计原创发型和服装特征')
        .replace(/按照片服装保留关键配饰/g, '为原创服装设计关键配饰')
        .replace(/从参考照片提取/g, '围绕旅行主题选择')
        .replace(/参考人物姓名/g, '用户指定嘉宾姓名')
        .replace(/(?:参考|上传)?照片(?:中|里)?(?:的)?人物身份/g, '原创人物')
        .replace(/(?:参考|上传)?照片服装/g, '原创角色服装')
        .replace(/(?:参考|上传)?照片衣服/g, '原创角色衣服');
      next = stripPhotoRequirements(next, extracted);
      if (next !== value) extracted.push(`照片模式可选参数「${name}」：${value}`);
      return [name, next || `与主题协调的${name}`];
    })) : t.parameterDefaults;
  const faceSwapPrompt = uniqueSentences([DEFAULT_FACE_SWAP_PROMPT, t.faceSwapPrompt, ...extracted]);
  return {
    ...t, supportsFaceSwap: true, requiresImage: false, mode: 'reference',
    faceSwapPrompt, ...(parameterDefaults === undefined ? {} : {parameterDefaults}), promptSections: sections,
    prompt: preserveResolvedPrompt ? raw : KEYS.map((key, i) => `【${LABELS[i]}】\n${sections[key]}`).join('\n\n'),
  };
}
