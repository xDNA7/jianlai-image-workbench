import { describe, expect, test } from 'bun:test'
import { compileStoryboard, normalizeStoryboard, resizeStoryboard, type VideoStoryboard } from '../src/chat/video-storyboard'

const plan: VideoStoryboard = { duration: 10, ratio: '16:9', resolution: '768P', shots: [
  { duration: 3, scene: '雨滴落下', camera: '低机位推进' },
  { duration: 7, scene: '街道灯光', camera: '缓慢抬升' },
] }

describe('single-video storyboard contract', () => {
  test('compiles an explicitly timed single video prompt and preserves edits', () => {
    expect(compileStoryboard(plan)).toContain('镜头1（0–3秒）：雨滴落下')
    expect(compileStoryboard(plan)).toContain('镜头2（3–10秒）：街道灯光')
    expect(compileStoryboard({ ...plan, shots: [{ ...plan.shots[0], scene: '修改后的雨滴' }, plan.shots[1]] })).toContain('修改后的雨滴')
  })
  test('refuses incoherent timing, empty fields, overlong scenes and unsupported ratio', () => {
    expect(normalizeStoryboard({ ...plan, duration: 15 })).toBeNull()
    expect(normalizeStoryboard({ ...plan, duration: 20 })).toBeNull()
    expect(normalizeStoryboard({ ...plan, shots: [{ duration: 10, scene: '', camera: '推进' }] })).toBeNull()
    expect(normalizeStoryboard({ ...plan, shots: [{ duration: 10, scene: '雨'.repeat(201), camera: '推进' }] })).toBeNull()
    expect(normalizeStoryboard({ ...plan, ratio: 'unsupported' })).toBeNull()
    expect(compileStoryboard({ ...plan, shots: [{ duration: 10, scene: '有效', camera: '' }] })).toBeNull()
  })
  test('duration edits preserve all scenes and have a positive exact timeline', () => {
    for (let duration = 4; duration <= 15; duration++) {
      const resized = resizeStoryboard(plan, duration)
      expect(resized.shots.map(shot => shot.scene)).toEqual(plan.shots.map(shot => shot.scene))
      expect(resized.shots.every(shot => shot.duration >= 1)).toBe(true)
      expect(resized.shots.reduce((total, shot) => total + shot.duration, 0)).toBe(duration)
      expect(normalizeStoryboard(resized)).not.toBeNull()
    }
  })
  test('invalid or under-capacity duration edits leave the plan intact', () => {
    expect(resizeStoryboard(plan, 20)).toBe(plan)
    expect(resizeStoryboard(plan, 4.5)).toBe(plan)
  })
})
