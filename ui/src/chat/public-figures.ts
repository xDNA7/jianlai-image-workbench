import type { Plan, PublicFigureSource } from './types'

export function validateCommonsResult(source: PublicFigureSource): PublicFigureSource | null {
  const validUrl = (raw: unknown, host: string) => {
    if (typeof raw !== 'string') return false
    try {
      const url = new URL(raw)
      return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port && !url.hash
    } catch { return false }
  }
  return source && validUrl(source.sourceUrl, 'commons.wikimedia.org') && validUrl(source.thumbUrl, 'upload.wikimedia.org') && validUrl(source.imageUrl, 'upload.wikimedia.org') && typeof source.title === 'string' && typeof source.artist === 'string' && source.artist.trim() && typeof source.license === 'string' && source.license.trim() ? source : null
}

const domesticImageHosts = ['image2.sina.com.cn', 'www.sinaimg.cn']
const domesticPageHosts = ['ent.sina.com.cn', 'slide.ent.sina.com.cn']
function allowedUrl(raw: unknown, hosts: string[]): URL | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash ? url : null
  } catch { return null }
}

export function isPublicFigureImageUrl(raw: string): boolean {
  return Boolean(allowedUrl(raw, ['upload.wikimedia.org', ...domesticImageHosts]))
}

export function figureSourceKey(source: PublicFigureSource): string | null {
  if (source.provider === 'Sogou/Sina') {
    const image = allowedUrl(source.imageUrl, domesticImageHosts)
    if (!image || !allowedUrl(source.thumbUrl, domesticImageHosts) || !allowedUrl(source.sourceUrl, domesticPageHosts) || typeof source.title !== 'string' || !source.title.trim() || source.artist !== '新浪娱乐' || source.license !== '来源页未标注许可，仅作人物参考') return null
    return `${image.hostname}${image.pathname}`
  }
  if ((source.provider && source.provider !== 'Wikimedia Commons') || !validateCommonsResult(source)) return null
  const url = new URL(source.sourceUrl)
  let file: string
  try { file = decodeURIComponent(url.pathname).replaceAll('_', ' ') }
  catch { return null }
  return file.startsWith('/wiki/File:') && !url.search ? `commons:${file}` : null
}

/** Each independently resolved person needs 2–4 distinct samples tied to one QID. */
export function validateFigureSources(value: unknown): PublicFigureSource[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) return []
  const sources = value as PublicFigureSource[]
  const entity = sources[0]?.entityId
  if (!entity || !/^Q[1-9]\d*$/.test(entity)) return []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!source || source.entityId !== entity || typeof source.personName !== 'string' || !source.personName.trim() || source.personName !== sources[0].personName) return []
    const key = figureSourceKey(source)
    if (!key || seen.has(key)) return []
    seen.add(key)
  }
  return sources
}

export function getPublicFigureNames(plan: Pick<Plan, 'publicFigure' | 'publicFigures' | 'publicFigureVisual'>): string[] {
  // Older persisted plans predate the explicit intent flag; keep them working.
  if (plan.publicFigureVisual === false) return []
  const legacy = plan.publicFigure?.trim() ?? ''
  const explicit = legacy.split(/[、，,／/]/u)
  const conjunction = legacy.split(/[与和]/u)
  const names = plan.publicFigures?.length ? plan.publicFigures : explicit.length > 1 ? explicit : conjunction.length === 2 && conjunction.every(name => name.trim().length >= 2) ? conjunction : [legacy]
  return [...new Set(names.map(name => name.trim()).filter(Boolean))]
}

/** Return all sources in declared person order, or reject the whole selection. */
export function validatePlanFigureSources(plan: Plan): PublicFigureSource[] {
  const names = getPublicFigureNames(plan)
  const all = plan.publicFigureSources ?? []
  if (!names.length || names.length > 2 || all.length > 4) return []
  const groups = names.map(name => validateFigureSources(all.filter(source => source.personName === name)))
  if (groups.some(group => !group.length)) return []
  const ordered = groups.flat()
  if (ordered.length !== all.length || new Set(groups.map(group => group[0].entityId)).size !== names.length || new Set(ordered.map(figureSourceKey)).size !== ordered.length) return []
  return ordered
}

/** Legacy plans may lack context; disclose only recognised occupation/show terms. */
export function getPublicFigureContext(plan: Plan): string | undefined {
  if (plan.publicFigureContext?.trim()) return plan.publicFigureContext.trim().slice(0, 80)
  const terms = ['超级女声', '快乐男声', '歌手', '演员', '主持人', '运动员', '导演', '作家'].filter(term => plan.prompt.includes(term))
  return terms.join(' ') || undefined
}
