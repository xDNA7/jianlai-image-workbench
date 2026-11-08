import { afterEach, describe, expect, test } from 'bun:test'
import { bootstrap, getJob, loadGallery, loadTemplates, loadVideos, request, toJobState } from '../src/chat/api'
import type { components } from '../src/api/generated'

type Wire = components['schemas']
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
function respond(payload: unknown, status = 200) {
  globalThis.fetch = (async () => Response.json(payload, { status })) as typeof fetch
}
const rawJob = { id: 'a'.repeat(32), status: 'done', charged: .3, availableCents: null, images: [
  { index: 0, url: 'api/jobs/test/images/0', previewUrl: null },
] } satisfies Wire['ImageJob']

describe('wire API contract at the client boundary', () => {
  test('keeps an unavailable balance null instead of turning it into zero', async () => {
    respond({ accountId: 'test', availableCents: null, capabilities: { sizes: [], qualities: [] }, activeJob: null } satisfies Wire['Bootstrap'])
    const value = await bootstrap()
    expect(value.availableCents).toBeNull()
    expect(value.capabilities.sizes.length).toBeGreaterThan(0)
    expect(toJobState(rawJob, 'prompt').availableCents).toBeNull()
  })

  test('checks server job status and image coordinates before rendering', async () => {
    respond(rawJob)
    expect(await getJob(rawJob.id, 'prompt')).toMatchObject({ status: 'done', chargedCents: 30, images: [{ index: 0 }] })
    respond({ ...rawJob, status: 'successful' })
    await expect(getJob(rawJob.id, 'prompt')).rejects.toThrow()
    respond({ ...rawJob, images: [{ index: -1, url: 'image.png' }] })
    await expect(getJob(rawJob.id, 'prompt')).rejects.toThrow()
  })

  test('rejects malformed gallery records instead of silently fabricating image IDs', async () => {
    respond({ records: [{ id: 'x', image: 'image.png', created: 1 }] })
    await expect(loadGallery()).rejects.toThrow()
    respond({ records: [{ id: 'x', jobId: rawJob.id, index: 0, image: 'image.png', previewUrl: null, created: 1 }] } satisfies Wire['History'])
    expect((await loadGallery())[0]).toMatchObject({ id: 'x', index: 0, created: 1 })
  })

  test('uses server template parameter defaults and nullable video URLs', async () => {
    respond({ templates: [{ id: 't', title: '模板', prompt: '{{scene}}', parameterDefaults: { scene: '江南' } }] } satisfies Wire['Templates'])
    expect((await loadTemplates())[0].prompt).toBe('江南')
    respond({ records: [{ id: rawJob.id, status: 'running', url: null, progress: 10, elapsedSeconds: 20 }] } satisfies Wire['Videos'])
    expect((await loadVideos())[0]).toMatchObject({ status: 'running', url: null, progress: 10 })
  })

  test('keeps error messages and ignores non-string provider error values', async () => {
    respond({ error: '额度不足' }, 402)
    await expect(request('generate')).rejects.toMatchObject({ status: 402, message: '额度不足' })
    respond({ error: { detail: 'private upstream value' } }, 502)
    await expect(request('generate')).rejects.toMatchObject({ status: 502, message: '请求失败，请稍后重试' })
  })
})
