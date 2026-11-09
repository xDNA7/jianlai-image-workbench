import { z } from 'zod'
import { moveShot } from './nomi/storyboard-edits'

export const videoStyles = [
  { value: 'auto', label: '未指定', prompt: '' },
  { value: 'monochrome-anime', label: '黑白动漫风格', prompt: '黑白动漫，清晰墨线与网点明暗，保持人物线稿与黑白层次一致' },
  { value: 'pixar', label: '皮克斯风格', prompt: '皮克斯风格三维角色动画，鲜明轮廓、细腻材质、柔和全局光照与富有表现力的动作' },
  { value: 'realistic', label: '真人短剧风格', prompt: '真人短剧摄影，自然皮肤微纹理与真实肤色，柔和有方向的光线，适度景深，保留皮肤细节，不过度美化' },
  { value: 'clay', label: '粘土动画风格', prompt: '手工粘土定格动画，保留揉捏指纹与黏土材质，微缩布景和有节奏的逐帧动作' },
  { value: 'chinese-aesthetic', label: '中式美学动画', prompt: '中式美学动画，传统色彩、留白构图与含蓄光影，保持东方意境和统一材质' },
  { value: 'shanghai-animation', label: '上海美术电影制片厂风格', prompt: '上海美术电影制片厂经典动画风格，手绘质感、民族装饰造型与精炼色彩，动作富有韵律' },
  { value: 'cel', label: '赛璐璐风格', prompt: '赛璐璐动画，清晰线条、平涂色块与边界分明的阴影，保持人物造型和色板稳定' },
  { value: 'custom', label: '自定义画风', prompt: '' },
] as const

export const videoStyleSchema = z.enum(['auto', 'monochrome-anime', 'pixar', 'realistic', 'clay', 'chinese-aesthetic', 'shanghai-animation', 'cel', 'custom'])

export const videoStoryboardSchema = z.object({
  duration: z.number().int().min(4).max(15),
  ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
  resolution: z.literal('768P'),
  style: videoStyleSchema.default('auto'),
  stylePrompt: z.string().trim().max(120).optional(),
  shots: z.array(z.object({
    duration: z.number().int().min(1).max(15),
    scene: z.string().trim().min(1).max(200),
    camera: z.string().trim().min(1).max(80),
  })).min(1).max(6),
  notice: z.string().max(400).optional(),
}).refine(value => value.shots.reduce((total, shot) => total + shot.duration, 0) === value.duration, '分镜时长之和须与总时长一致')

export type VideoStoryboard = z.infer<typeof videoStoryboardSchema>

export function normalizeStoryboard(value: unknown): VideoStoryboard | null {
  const legacy = value && typeof value === 'object' && 'resolution' in value && value.resolution === '2K' ? { ...value, resolution: '768P' } : value
  const result = videoStoryboardSchema.safeParse(legacy)
  if (!result.success) return null
  return compileStoryboard(result.data) ? result.data : null
}

/** A single prompt for one paid task, with explicit continuous timeline. */
export function compileStoryboard(value: VideoStoryboard): string | null {
  const parsed = videoStoryboardSchema.safeParse(value)
  if (!parsed.success) return null
  let time = 0
  const lines = parsed.data.shots.map((shot, index) => {
    const start = time
    time += shot.duration
    return `镜头${index + 1}（${start}–${time}秒）：${shot.scene}\n运镜：${shot.camera}`
  })
  const style = parsed.data.style === 'custom' ? parsed.data.stylePrompt : videoStyles.find(style => style.value === parsed.data.style)?.prompt
  if (parsed.data.style === 'custom' && !style) return null
  const prompt = `生成一条连续的${value.duration}秒视频，镜头之间自然衔接，保持主体与风格一致。\n${style ? `画风：${style}。\n` : ''}${lines.join('\n')}`
  return Array.from(prompt).length <= 2000 ? prompt : null
}

export function resizeStoryboard(value: VideoStoryboard, duration: number): VideoStoryboard {
  if (!Number.isInteger(duration) || duration < 4 || duration > 15 || duration < value.shots.length) return value
  // Keep every scene, then distribute the remaining time in proportion to the old timeline.
  const remaining = duration - value.shots.length
  const weights = value.shots.map(shot => shot.duration / value.duration * remaining)
  const counts = weights.map(weight => 1 + Math.floor(weight))
  let extra = duration - counts.reduce((sum, count) => sum + count, 0)
  const order = weights.map((weight, index) => ({ index, remainder: weight % 1 })).sort((a, b) => b.remainder - a.remainder)
  for (const { index } of order) { if (extra-- <= 0) break; counts[index]++ }
  return { ...value, duration, shots: value.shots.map((shot, index) => ({ ...shot, duration: counts[index] })) }
}


export function moveStoryboardShot(value: VideoStoryboard, from: number, to: number): VideoStoryboard {
  const shots = moveShot(value.shots, from, to)
  return shots === value.shots ? value : { ...value, shots }
}

function redistributeShots(value: VideoStoryboard, shots: VideoStoryboard['shots']): VideoStoryboard {
  return resizeStoryboard({ ...value, shots, duration: shots.reduce((total, shot) => total + shot.duration, 0) }, value.duration)
}

export function duplicateStoryboardShot(value: VideoStoryboard, index: number): VideoStoryboard {
  if (!Number.isInteger(index) || index < 0 || index >= value.shots.length || value.shots.length >= Math.min(6, value.duration)) return value
  const shots = [...value.shots]
  shots.splice(index + 1, 0, { ...shots[index] })
  return redistributeShots(value, shots)
}

export function removeStoryboardShot(value: VideoStoryboard, index: number): VideoStoryboard {
  if (!Number.isInteger(index) || index < 0 || index >= value.shots.length || value.shots.length <= 1) return value
  return redistributeShots(value, value.shots.filter((_, current) => current !== index))
}
