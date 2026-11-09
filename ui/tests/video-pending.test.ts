import { expect, test } from 'bun:test'
import { videoPayloadHash, type VideoPayload } from '../src/chat/video-pending'

const payload: VideoPayload = { prompt: '雨后窗边', duration: 15, ratio: '16:9', resolution: '768P', image: '' }

test('legacy pending hashes are unchanged when new style fields are absent', async () => {
  const original = new TextEncoder().encode(JSON.stringify(payload))
  const digest = await crypto.subtle.digest('SHA-256', original)
  const expected = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  expect(await videoPayloadHash(payload)).toBe(expected)
  expect(await videoPayloadHash({ ...payload, style: undefined, stylePrompt: undefined })).toBe(expected)
  expect(await videoPayloadHash({ ...payload, style: 'auto', stylePrompt: '' })).toBe(expected)
})

test('changing style or its custom description prevents retrying a different paid input', async () => {
  const original = await videoPayloadHash(payload)
  expect(await videoPayloadHash({ ...payload, style: 'clay' })).not.toBe(original)
  expect(await videoPayloadHash({ ...payload, style: 'custom', stylePrompt: '水彩' })).not.toBe(await videoPayloadHash({ ...payload, style: 'custom', stylePrompt: '水墨' }))
})
