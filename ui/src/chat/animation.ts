import type { AnimationPlan, AnimationMetadata } from './types'

export function explicitlyStatic(prompt: string): boolean {
  const intent = prompt.toLowerCase().replace(/(?:不要|不需要|不生成|无需|不用)\s*静态(?:图片|图|画面)?/g, '')
  return /(?:不要|无需|不需要|不用|不生成|取消)\s*(?:(?<![a-z])gif(?![a-z])(?:\s*动图)?|动图|动画)|(?:改为|改成|只要|仅要|生成|一张)\s*静态(?:图|图片|画面)?/i.test(intent)
}

/** Mirrors the conservative server recommendation for the as-written fallback. */
export function recommendAnimation(prompt: string): AnimationPlan | undefined {
  if (explicitlyStatic(prompt) || !/(?<![a-z])gif(?![a-z])|动图|循环动画|(?:生成|制作|做)(?:一段|一个)?动画/i.test(prompt)) return undefined
  const chinese: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const number = (text: string): number => {
    if (/^\d/.test(text)) return Number(text)
    if (text.includes('十')) { const [tens, units] = text.split('十'); return (tens ? chinese[tens] : 1) * 10 + (units ? chinese[units] : 0) }
    return chinese[text]
  }

  const match = prompt.match(/(\d+(?:\.\d+)?|[零一二两三四五六七八九十]+)\s*(?:秒|seconds?\b|secs?\b|s\b)/i)
  const requested = match ? number(match[1]) : 3
  const durationSeconds = Math.min(6, Math.max(1, Math.round(requested || 3)))
  const fps = prompt.match(/(?:每秒\s*(\d+|[零一二两三四五六七八九十]+)\s*帧|(\d+|[零一二两三四五六七八九十]+)\s*(?:fps|帧\s*[/／]\s*秒))/i)
  const adjusted = requested !== durationSeconds || Boolean(fps && number(fps[1] || fps[2]) !== 4)
  return { fps: 4, durationSeconds, frames: durationSeconds * 4, notice: adjusted ? '已优化为每秒 4 帧、最多 6 秒（24 帧），以兼顾画质与生成稳定性。' : undefined }
}

/** A plan may carry GIF intent separately from its model-written visual prompt. */
export function animationForEditedPrompt(previous: AnimationPlan | undefined, prompt: string): AnimationPlan | undefined {
  if (explicitlyStatic(prompt)) return undefined
  if (!previous) return recommendAnimation(prompt)
  if (/(?:[0-9零一二两三四五六七八九十]+(?:\.[0-9]+)?\s*(?:秒|seconds?\b|secs?\b|s\b|fps|帧)|每秒)/i.test(prompt)) return recommendAnimation(`GIF ${prompt}`)
  return previous
}

export function normalizeAnimation(value: unknown, prompt: string): AnimationPlan | undefined {
  if (!value || typeof value !== 'object') return recommendAnimation(prompt)
  const v = value as Record<string, unknown>
  if (typeof v.fps !== 'number' || typeof v.durationSeconds !== 'number' || !Number.isFinite(v.fps) || !Number.isFinite(v.durationSeconds)) return recommendAnimation(prompt)
  const durationSeconds = Math.min(6, Math.max(1, Math.round(v.durationSeconds)))
  const adjusted = v.fps !== 4 || durationSeconds !== v.durationSeconds
  return { fps: 4, durationSeconds, frames: durationSeconds * 4, notice: adjusted ? '已优化为每秒 4 帧、最多 6 秒（24 帧），以兼顾画质与生成稳定性。' : typeof v.notice === 'string' ? v.notice : undefined }
}

export function imageExtension(image: { type?: string; download: string }): string {
  const known: Record<string, string> = { 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
  return known[image.type ?? ''] ?? image.download.split(/[?#]/)[0].match(/\.(gif|png|jpe?g|webp)$/i)?.[1].toLowerCase() ?? 'png'
}

export function animationSummary(animation?: AnimationMetadata): string {
  return animation ? `${animation.frames} 帧 · ${(animation.durationMs / 1000).toFixed(2)} 秒 · ${Number(animation.fps.toFixed(2))} 帧/秒 · ${animation.width}×${animation.height}` : ''
}
