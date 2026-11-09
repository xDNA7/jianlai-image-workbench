import { describe, expect, test } from 'bun:test'
import { compileStoryboard, duplicateStoryboardShot, moveStoryboardShot, normalizeStoryboard, removeStoryboardShot, resizeStoryboard, videoStyles, type VideoStoryboard } from '../src/chat/video-storyboard'

const plan: VideoStoryboard = { duration: 10, ratio: '16:9', resolution: '768P', style: 'auto', shots: [
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


describe('workbench shot edits', () => {
  test('reorders the final prompt without changing timing or the original plan', () => {
    const moved = moveStoryboardShot(plan, 0, 1)
    expect(moved.shots.map(shot => shot.scene)).toEqual(['街道灯光', '雨滴落下'])
    expect(moved.shots.map(shot => shot.duration)).toEqual([7, 3])
    expect(compileStoryboard(moved)).toContain('镜头1（0–7秒）：街道灯光')
    expect(plan.shots.map(shot => shot.scene)).toEqual(['雨滴落下', '街道灯光'])
    for (const [from, to] of [[0, 0], [-1, 0], [0, 2], [0.5, 1], [0, NaN]]) expect(moveStoryboardShot(plan, from, to)).toBe(plan)
  })
  test('duplicate and delete keep a valid exact timeline at every supported total duration', () => {
    for (let duration = 4; duration <= 15; duration++) {
      let edited = resizeStoryboard(plan, duration)
      while (edited.shots.length < Math.min(6, duration)) {
        edited = duplicateStoryboardShot(edited, 0)
        expect(edited.duration).toBe(duration)
        expect(normalizeStoryboard(edited)).not.toBeNull()
        expect(edited.shots.every(shot => shot.duration >= 1)).toBe(true)
      }
      expect(duplicateStoryboardShot(edited, 0)).toBe(edited)
      while (edited.shots.length > 1) {
        edited = removeStoryboardShot(edited, edited.shots.length - 1)
        expect(edited.duration).toBe(duration)
        expect(normalizeStoryboard(edited)).not.toBeNull()
      }
      expect(edited.shots[0].duration).toBe(duration)
      expect(removeStoryboardShot(edited, 0)).toBe(edited)
    }
  })
  test('duplicates scalar content independently and rejects invalid edit indices', () => {
    const copied = duplicateStoryboardShot(plan, 0)
    expect(copied.shots[1].scene).toBe(plan.shots[0].scene)
    expect(copied.shots[1]).not.toBe(copied.shots[0])
    copied.shots[1].scene = '独立修改'
    expect(plan.shots[0].scene).toBe('雨滴落下')
    for (const index of [-1, 2, 0.5, NaN]) {
      expect(duplicateStoryboardShot(plan, index)).toBe(plan)
      expect(removeStoryboardShot(plan, index)).toBe(plan)
    }
  })
})


describe('video style and legacy drafts', () => {
  test('restores older drafts with auto style and supported resolution', () => {
    const { style: _style, ...legacy } = plan
    expect(normalizeStoryboard({ ...legacy, resolution: '2K' })).toMatchObject({ style: 'auto', resolution: '768P' })
    expect(compileStoryboard({ ...plan, resolution: '2K' as '768P' })).toBeNull()
  })
  test('keeps animation materials separate from realistic skin guidance', () => {
    expect(compileStoryboard({ ...plan, style: 'realistic' })).toContain('自然皮肤微纹理')
    for (const style of videoStyles.filter(style => !['auto', 'realistic', 'custom'].includes(style.value))) {
      const prompt = compileStoryboard({ ...plan, style: style.value })
      expect(prompt).toContain(style.prompt)
      expect(prompt).not.toContain('皮肤微纹理')
    }
    expect(compileStoryboard(plan)).not.toContain('画风：')
  })
  test('validates custom style and preserves style through shot edits', () => {
    expect(compileStoryboard({ ...plan, style: 'custom' })).toBeNull()
    expect(compileStoryboard({ ...plan, style: 'custom', stylePrompt: '  水彩纸张，清淡色彩  ' })).toContain('画风：水彩纸张，清淡色彩。')
    expect(normalizeStoryboard({ ...plan, style: 'custom', stylePrompt: '画'.repeat(121) })).toBeNull()
    expect(normalizeStoryboard({ ...plan, style: 'unknown' })).toBeNull()
    const styled = { ...plan, style: 'clay' as const }
    expect(resizeStoryboard(duplicateStoryboardShot(styled, 0), 15).style).toBe('clay')
  })
})
