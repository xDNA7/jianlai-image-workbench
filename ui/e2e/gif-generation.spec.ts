import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const JOB = 'f'.repeat(32)
const MEDIA = 'https://public-assets.example/gif-test/'
// A programmatic one-pixel, 12-frame GIF fixture; no generated artwork.
const GIF = Buffer.concat([
  Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
  ...Array.from({ length: 12 }, () => Buffer.from('21f90400190000002c0000000001000100000202440100', 'hex')),
  Buffer.from([0x3b]),
])
const PREVIEW = readFileSync(new URL('../src/design/orange-example.webp', import.meta.url))
const PLAN = { fps: 4, durationSeconds: 3, frames: 12 }
const MEASURED = { frames: 12, durationMs: 3000, fps: 4, width: 1, height: 1 }

async function install(page: Page, animated: boolean) {
  const submitted: Record<string, unknown>[] = []
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(`${MEDIA}**`, route => route.fulfill(route.request().url().endsWith('.gif') ? { contentType: 'image/gif', body: GIF } : { contentType: 'image/webp', body: PREVIEW }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/bootstrap')) return json(route, { accountId: 'gif-e2e', availableCents: 5000, imagePriceCents: 30, activeJob: null, activeVideo: null, capabilities: { sizes: [{ value: 'auto', label: '自动画幅' }], qualities: [{ value: 'medium', label: '精细' }] } })
    if (path.endsWith('/templates')) return json(route, { templates: [] })
    if (path.endsWith('/history') || path.endsWith('/videos')) return json(route, { records: [] })
    if (path.endsWith('/video-access')) return json(route, { authenticated: false })
    if (path.endsWith('/chat') && route.request().method() === 'GET') return json(route, { used: 0, limit: 50 })
    if (path.endsWith('/chat')) return route.fulfill({ contentType: 'text/event-stream', body: [
      ['delta', { text: '已推荐动图参数。' }],
      ['plan', { prompt: '小猫揉面', text: '', size: 'auto', quality: 'medium', count: 1, useReference: submitted.length > 0, animation: submitted.length ? undefined : PLAN }],
      ['done', {}],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') })
    if (path.endsWith('/generate')) { submitted.push(route.request().postDataJSON()); return json(route, { id: JOB, status: 'running', phase: 'queued' }, 202) }
    if (/\/jobs\/[a-f0-9]{32}\/images\/0$/.test(path)) return route.fulfill({ contentType: 'image/gif', body: GIF })
    if (path.includes('/jobs/')) return json(route, { id: JOB, status: 'done', phase: 'done', charged: .3, availableCents: 4970,
      error: animated ? '' : '上游返回静态图片，动图未达标，未自动重试。',
      images: [{ index: 0, url: `${MEDIA}original.${animated ? 'gif' : 'webp'}`, previewUrl: `${MEDIA}preview.webp`, type: animated ? 'image/gif' : 'image/webp', animation: animated ? MEASURED : null }],
    })
    return json(route, { error: `Unexpected mocked API request: ${path}` }, 501)
  })
  return submitted
}

for (const animated of [true, false]) test(`GIF recommendation, confirmation and ${animated ? 'original playback' : 'static fallback warning'}`, async ({ page }, info) => {
  const submitted = await install(page, animated)
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('小猫揉面 GIF 动图')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const plan = page.getByRole('region', { name: '生成方案' })
  await expect(plan.getByText(/GIF 动图 · 4 帧\/秒 · 3 秒 · 12 帧/)).toBeVisible()
  expect(submitted).toHaveLength(0)
  await plan.getByText('编辑方案', { exact: true }).click()
  await plan.getByRole('textbox', { name: '画面描述', exact: true }).fill('小猫在木桌前揉面')
  await expect(plan.getByText(/GIF 动图 · 4 帧\/秒 · 3 秒 · 12 帧/)).toBeVisible()
  await plan.getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText('已完成 · 1 张', { exact: false })).toBeVisible()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ animation: PLAN, count: 1 })
  const result = page.locator('.job-card figure')
  await expect(result.locator('img')).toHaveAttribute('src', `${MEDIA}preview.webp`)
  await expect(result.getByRole('link', { name: '下载原图' })).toHaveAttribute('download', `jianlai-${JOB}-0.${animated ? 'gif' : 'webp'}`)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-gif-${animated ? 'animated' : 'static'}.png` })
  if (animated) {
    await expect(result.locator('figcaption')).toHaveText('GIF · 12 帧 · 3.00 秒 · 4 帧/秒 · 1×1')
    await result.getByRole('button', { name: '放大查看' }).click()
    await expect(page.getByTestId('zoom-image')).toHaveAttribute('src', `${MEDIA}original.gif`)
    await expect(page.getByRole('dialog').getByRole('link', { name: '下载原图' })).toHaveAttribute('download', `jianlai-${JOB}-0.gif`)
  } else {
    await expect(result.locator('figcaption')).toHaveText('上游返回静态图片，未生成动图。')
    await expect(page.getByText(/未自动重试/)).toBeVisible()
    expect(submitted).toHaveLength(1)
  }
})


test('GIF editing preserves independent animation intent and sends a real PNG first frame', async ({ page }) => {
  const submitted = await install(page, true)
  await page.goto('/', { waitUntil: 'networkidle' })
  const input = page.getByRole('textbox', { name: '描述你想要的画面' })
  await input.fill('小猫揉面 GIF 动图')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('region', { name: '生成方案' }).last().getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  await page.getByRole('button', { name: '修改这张图' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '不标记，直接带入对话' }).click()
  await expect(page.getByText('使用 GIF 首帧作为参考，重新生成动图')).toBeVisible()
  await input.fill('脚没动起来')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const plan = page.getByRole('region', { name: '生成方案' }).last()
  await expect(plan.getByText(/GIF 动图 · 4 帧\/秒 · 3 秒 · 12 帧/)).toBeVisible()
  await plan.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => submitted.length).toBe(2)
  expect(submitted[1]).toMatchObject({ mode: 'edit', animation: PLAN })
  const reference = (submitted[1].references as string[])[0]
  expect(reference).toMatch(/^data:image\/png;base64,/)
  expect(Buffer.from(reference.split(',')[1], 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
})


for (const staticOutput of [false, true]) test(`GIF chat failure direct generation ${staticOutput ? 'respects explicit static intent' : 'inherits canonical reference animation'}`, async ({ page }) => {
  const submitted = await install(page, true)
  await page.goto('/', { waitUntil: 'networkidle' })
  const input = page.getByRole('textbox', { name: '描述你想要的画面' })
  await input.fill('小猫揉面 GIF 动图')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('region', { name: '生成方案' }).last().getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  await page.getByRole('button', { name: '修改这张图' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '不标记，直接带入对话' }).click()
  await page.route('**/api/chat', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, contentType: 'application/json', json: { error: '对话暂不可用' } }) : route.fallback())
  await input.fill(staticOutput ? '改成静态图，脚抬起来' : '脚没动起来')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('button', { name: /按原文直接生成/ }).click()
  await expect.poll(() => submitted.length).toBe(2)
  expect(submitted[1]).toMatchObject({ mode: 'edit' })
  if (staticOutput) expect(submitted[1].animation).toBeUndefined()
  else expect(submitted[1].animation).toEqual(PLAN)
  const reference = (submitted[1].references as string[])[0]
  expect(reference).toMatch(/^data:image\/png;base64,/)
  expect(Buffer.from(reference.split(',')[1], 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
})
