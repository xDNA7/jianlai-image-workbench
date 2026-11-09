import { expect, test } from 'bun:test'
import { animationForEditedPrompt, animationSummary, imageExtension, normalizeAnimation, recommendAnimation } from '../src/chat/animation'
import { normalizePlan, submitGenerate, toJobImages } from '../src/chat/api'

test('recommends conservative GIF parameters and does not animate static requests', () => {
  expect(recommendAnimation('黏土动图')).toMatchObject({ fps: 4, durationSeconds: 3, frames: 12 })
  expect(recommendAnimation('三秒 GIF')).toMatchObject({ durationSeconds: 3, frames: 12 })
  expect(recommendAnimation('GIF 15秒 每秒24帧')).toMatchObject({ fps: 4, durationSeconds: 6, frames: 24 })
  expect(recommendAnimation('不要动图，画静态图片')).toBeUndefined()
  expect(recommendAnimation('不要静态图，要GIF动图')).toMatchObject({ frames: 12 })
  expect(recommendAnimation('阿德曼动画风格插画')).toBeUndefined()
  expect(recommendAnimation('循环动画，每秒八帧，三秒钟')).toMatchObject({ frames: 12 })
  expect(recommendAnimation('GIF 十五秒')).toMatchObject({ durationSeconds: 6 })
  expect(recommendAnimation('gift box')).toBeUndefined()
  expect(recommendAnimation('beautiful gifts')).toBeUndefined()
  expect(recommendAnimation('GIF动图')).toMatchObject({ frames: 12 })
  expect(recommendAnimation('画一个女孩')).toBeUndefined()
  expect(normalizeAnimation({ fps: 30, durationSeconds: 12, frames: 999 }, 'GIF')).toMatchObject({ fps: 4, durationSeconds: 6, frames: 24 })
  expect(normalizePlan({ prompt: 'GIF 动图', count: 2 })).toMatchObject({ count: 1, animation: { fps: 4, durationSeconds: 3, frames: 12 } })
})

test('preserves measured GIF metadata and uses the real download format', () => {
  const animation = { frames: 12, durationMs: 3000, fps: 4, width: 320, height: 320 }
  const [image] = toJobImages({ id: 'gif-job', status: 'done', charged: 0.3, availableCents: null, images: [{ index: 0, url: 'original.gif', previewUrl: 'preview.webp', type: 'image/gif', animation }] }, 'GIF')
  expect(image).toMatchObject({ type: 'image/gif', animation })
  expect(image.preview).toContain('preview.webp')
  expect(image.download).toContain('original.gif')
  expect(imageExtension(image)).toBe('gif')
  expect(imageExtension({ download: 'x.webp?signature=redacted' })).toBe('webp')
  expect(imageExtension({ download: 'api/opaque', type: 'image/jpeg' })).toBe('jpg')
  expect(animationSummary(animation)).toContain('12 帧 · 3.00 秒 · 4 帧/秒')
})


test('animated submission always requests one result and keeps the request key', async () => {
  const original = globalThis.fetch
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return Response.json({ id: 'gif-submit', status: 'running' })
  }) as typeof fetch
  try {
    await submitGenerate({ plan: { prompt: '猫咪 GIF', text: '', size: 'auto', quality: 'medium', count: 2, useReference: false, animation: { fps: 4, durationSeconds: 3, frames: 12 } }, requestKey: 'gif-request-key-stable' })
    expect(body).toMatchObject({ count: 1, compare: false, requestKey: 'gif-request-key-stable', animation: { fps: 4, durationSeconds: 3, frames: 12 } })
  } finally { globalThis.fetch = original }
})


test('editing a visual description preserves separate GIF intent unless explicitly changed', () => {
  const previous = { fps: 4, durationSeconds: 3, frames: 12 }
  expect(animationForEditedPrompt(previous, '猫咪在月下跳舞')).toEqual(previous)
  expect(animationForEditedPrompt({ fps: 4, durationSeconds: 6, frames: 24 }, '猫咪 GIF 在月下跳舞')).toMatchObject({ durationSeconds: 6, frames: 24 })
  expect(animationForEditedPrompt(previous, '猫咪跳舞，5秒')).toMatchObject({ durationSeconds: 5, frames: 20 })
  expect(animationForEditedPrompt(previous, '猫咪跳舞，改成静态图')).toBeUndefined()
  expect(animationForEditedPrompt(previous, '不要GIF，生成一张海报')).toBeUndefined()
  expect(animationForEditedPrompt(undefined, '猫咪跳舞')).toBeUndefined()
})
