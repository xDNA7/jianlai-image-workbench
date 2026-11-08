import { z } from 'zod'

export const videoStoryboardSchema = z.object({
  duration: z.number().int().min(4).max(15),
  ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
  resolution: z.enum(['768P', '2K']),
  shots: z.array(z.object({
    duration: z.number().int().min(1).max(15),
    scene: z.string().trim().min(1).max(200),
    camera: z.string().trim().min(1).max(80),
  })).min(1).max(6),
  notice: z.string().max(400).optional(),
}).refine(value => value.shots.reduce((total, shot) => total + shot.duration, 0) === value.duration, '分镜时长之和须与总时长一致')

export type VideoStoryboard = z.infer<typeof videoStoryboardSchema>

export function normalizeStoryboard(value: unknown): VideoStoryboard | null {
  const result = videoStoryboardSchema.safeParse(value)
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
  const prompt = `生成一条连续的${value.duration}秒视频，镜头之间自然衔接，保持主体与风格一致。\n${lines.join('\n')}`
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
