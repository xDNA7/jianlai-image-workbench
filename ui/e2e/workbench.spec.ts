import { deflateSync } from 'node:zlib'
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const OSS = 'https://public-assets.example/assets/jianlai/'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}
/** A real, valid solid-colour PNG of any size, so layout tests have true dimensions. */
const solidPng = (w: number, h: number, rgb: [number, number, number]) => {
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PREVIEW_PNG = solidPng(300, 450, [226, 214, 190])
const ORIGINAL_PNG = solidPng(1200, 1800, [214, 198, 170])
const JOB = 'a'.repeat(32)

type Mock = {
  generates: any[]
  chats: any[]
  chatFails: boolean
  history: any[]
  jobStatus: 'running' | 'done'
  plan: Record<string, unknown>
  generateResponses: { status: number; body: unknown }[]
  jobResponses: { status: number; body: unknown }[]
}

const sse = (events: [string, unknown][]) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

async function install(page: Page): Promise<Mock> {
  const mock: Mock = {
    generates: [], chats: [], chatFails: false, history: [], jobStatus: 'done',
    plan: { prompt: '雨后江南小镇，清晨薄雾', text: '', size: '1536x1024', quality: 'medium', count: 2, useReference: false },
    generateResponses: [], jobResponses: [],
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(`${OSS}**`, (route) => {
    const url = route.request().url()
    const body = url.includes('/original') ? ORIGINAL_PNG : url.includes('/preview') ? PREVIEW_PNG : PNG
    return route.fulfill({ status: 200, contentType: 'image/png', body })
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/bootstrap')) {
      return json(route, {
        accountId: 'acct-1', availableCents: 5000, imagePriceCents: 30, activeJob: null, activeVideo: null,
        capabilities: {
          sizes: [{ value: 'auto', label: '自动画幅' }, { value: '1536x1024', label: '3:2 · 横版' }, { value: '1024x1536', label: '2:3 · 竖版' }],
          qualities: [{ value: 'medium', label: '精细' }, { value: 'high', label: '高质量' }],
        },
      })
    }
    if (path.endsWith('/templates')) {
      return json(route, { templates: [{ id: 't1', title: '纸艺剧场', prompt: '纸艺风格的小剧场', category: 'fun', preview: 'templates/v2/a.webp' }] })
    }
    if (path.endsWith('/history')) return json(route, { records: mock.history })
    if (path.endsWith('/videos')) return json(route, { records: [] })
    if (path.endsWith('/api/chat') && request.method() === 'GET') return json(route, { used: 0, limit: 50 })
    if (path.endsWith('/api/chat')) {
      mock.chats.push(request.postDataJSON())
      if (mock.chatFails) return json(route, { error: '对话服务暂时不可用' }, 502)
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          ['meta', { used: mock.chats.length, limit: 50 }],
          ['delta', { text: '明白了，' }],
          ['delta', { text: '我整理成下面的方案：' }],
          ['plan', mock.plan],
          ['done', {}],
        ]),
      })
    }
    if (path.endsWith('/api/generate')) {
      mock.generates.push(request.postDataJSON())
      const response = mock.generateResponses.shift()
      if (response) return json(route, response.body, response.status)
      return json(route, { id: JOB, status: 'running', phase: 'queued' }, 202)
    }
    if (path.includes('/api/jobs/') && mock.jobResponses.length) {
      const response = mock.jobResponses.shift()!
      return json(route, response.body, response.status)
    }
    if (path.includes('/api/jobs/') && mock.jobStatus === 'running') {
      return json(route, { id: JOB, status: 'running', phase: 'generating', images: [] })
    }
    if (path.includes('/api/jobs/')) {
      return json(route, {
        id: JOB, status: 'done', phase: 'done', charged: 0.3, availableCents: 4970,
        images: [{ index: 0, url: `${OSS}j/original.png`, previewUrl: `${OSS}j/preview.png`, downloadUrl: `${OSS}j/original.png` }],
      })
    }
    return json(route, {})
  })
  return mock
}

const businessShot = async (page: Page, project: string, state: string) => {
  const directory = '/tmp/jianlai-ui-business'
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: `${directory}/${project}-${state}.png` })
}

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

test('a confirmed 413 compresses the uploaded image and retries only once with a new key', async ({ page }) => {
  const mock = await install(page)
  mock.plan = { prompt: '参考图的主体', size: 'auto', quality: 'medium', count: 1, useReference: true }
  mock.generateResponses.push({ status: 413, body: { error: '请求内容过大' } })
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: solidPng(4000, 3000, [20, 90, 160]) })
  await send(page, '根据参考图生成')
  const card = page.getByRole('region', { name: '生成方案' })
  await card.getByRole('button', { name: '生成', exact: true }).click()
  // Encoding a 12 MP image can exceed the default 5 s assertion window under load.
  const retryStarted = Date.now()
  await expect.poll(() => mock.generates.length, { timeout: 15_000 }).toBe(2)
  test.info().annotations.push({ type: '413-compression-retry-ms', description: String(Date.now() - retryStarted) })
  expect(mock.generates[0].requestKey).not.toBe(mock.generates[1].requestKey)
  expect(mock.generates[0].references[0].length).toBeGreaterThan(mock.generates[1].references[0].length)
})

test('failed jobs show the reason and that the failed task was not charged', async ({ page }) => {
  const mock = await install(page)
  mock.jobResponses.push({ status: 200, body: { id: JOB, status: 'failed', error: '上游超时', chargedCents: 0, availableCents: 5000, images: [] } })
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  const failure = page.getByRole('alert').filter({ hasText: '上游超时' })
  await expect(failure).toContainText('未扣费')
  await expect(failure.getByRole('button', { name: '按原方案重新生成' })).toBeVisible()
})

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  )
test('renders the chat shell without failed resources or overflow', async ({ page }, info) => {
  await install(page)
  const failed: string[] = []
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`))
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: '把想法，变成画面。' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '描述你想要的画面' })).toBeVisible()
  await noOverflow(page)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-welcome.png` })
  await businessShot(page, info.project.name, 'welcome')
  expect(failed).toEqual([])
})

test('plan card gates generation: nothing is generated or charged until confirmed', async ({ page }, info) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  const card = page.getByRole('region', { name: '生成方案' })
  await expect(card).toBeVisible()
  await expect(page.getByText('我整理成下面的方案')).toBeVisible()
  await expect(card.getByText('¥0.60')).toBeVisible()
  expect(mock.generates).toHaveLength(0)
  expect(mock.chats[0].messages).toEqual([{ role: 'user', content: '雨后江南小镇' }])
  await page.screenshot({ path: `test-results/shots/${info.project.name}-plan.png` })
  await businessShot(page, info.project.name, 'compact-plan')
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(mock.generates).toHaveLength(1)
  expect(mock.generates[0]).toMatchObject({ count: 2, compare: true, mode: 'reference', references: [], size: '1536x1024' })
  expect(mock.generates[0].requestKey).toMatch(/^[a-zA-Z0-9-]{16,80}$/)
  await noOverflow(page)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-done.png` })
  await businessShot(page, info.project.name, 'result')
})

test('the compact plan preserves edits across collapse and reload until explicitly confirmed', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  const card = page.getByRole('region', { name: '生成方案' })
  const editor = card.locator('details')
  const edit = card.locator('summary').filter({ hasText: '编辑方案' })
  const confirm = card.getByRole('button', { name: '生成', exact: true })
  await expect(editor).not.toHaveAttribute('open', '')
  await expect(card.getByLabel('画面描述')).toBeHidden()
  await expect(card.getByRole('combobox', { name: '画幅' })).toBeHidden()
  await expect(confirm).toHaveText('确认生成')
  await expect(confirm).toBeVisible()
  expect((await card.boundingBox())!.height).toBeLessThanOrEqual(360)
  await edit.click()
  await card.getByLabel('画面描述').fill('黄昏的江南小镇，挂着暖色灯笼')
  await card.getByLabel('画面文字（可选）').fill('江南好时节')
  await card.getByRole('combobox', { name: '画幅' }).click()
  await page.getByRole('option', { name: '2:3 · 竖版' }).click()
  await card.getByRole('combobox', { name: '质量' }).click()
  await page.getByRole('option', { name: '高质量' }).click()
  await card.getByRole('combobox', { name: '张数' }).click()
  await page.getByRole('option', { name: '1 张', exact: true }).click()
  await edit.click()
  await expect(editor).not.toHaveAttribute('open', '')
  await expect(card).toContainText('黄昏的江南小镇，挂着暖色灯笼')
  await expect(card).toContainText('¥0.30')
  expect(mock.generates).toHaveLength(0)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(editor).not.toHaveAttribute('open', '')
  await edit.click()
  await expect(card.getByLabel('画面描述')).toHaveValue('黄昏的江南小镇，挂着暖色灯笼')
  await expect(card.getByLabel('画面文字（可选）')).toHaveValue('江南好时节')
  await expect(card.getByRole('combobox', { name: '画幅' })).toContainText('2:3')
  await expect(card.getByRole('combobox', { name: '质量' })).toContainText('高质量')
  await expect(card.getByRole('combobox', { name: '张数' })).toContainText('1 张')
  await edit.click()
  await confirm.click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0]).toMatchObject({
    prompt: '黄昏的江南小镇，挂着暖色灯笼', text: '江南好时节',
    size: '1024x1536', quality: 'high', count: 1,
  })
})

test('abandoning a plan is explicit and never generates or charges', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  const card = page.getByRole('region', { name: '生成方案' })
  await card.locator('summary').filter({ hasText: '编辑方案' }).click()
  await expect(card.getByLabel('画面描述')).toBeVisible()
  await expect(card.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
  await expect(page.getByText('已放弃这个方案', { exact: true })).toHaveCount(0)
  expect(mock.generates).toHaveLength(0)
  await card.getByRole('button', { name: '放弃方案', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByText('已放弃这个方案', { exact: true })).toBeVisible()
  expect(mock.generates).toHaveLength(0)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByText('已放弃这个方案', { exact: true })).toBeVisible()
  expect(mock.generates).toHaveLength(0)
})

test('reduced motion keeps generation status and stop recovery usable without looping animations', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mock = await install(page)
  mock.jobStatus = 'running'
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  const waiting = page.locator('.generation-waiting')
  await expect(waiting).toBeVisible()
  await expect(waiting.getByRole('status')).toHaveText('生成中')
  await expect(waiting.getByRole('progressbar', { name: '生成进度' })).toHaveAttribute('aria-valuetext', '生成中')
  await expect(waiting).toContainText('停止等待不会取消服务端任务。')
  await expect(waiting.getByRole('button', { name: '停止等待' })).toBeEnabled()
  await expect.poll(() => waiting.evaluate((element) =>
    element.getAnimations({ subtree: true }).filter((animation) =>
      animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity,
    ).length,
  )).toBe(0)
  await noOverflow(page)
  await businessShot(page, info.project.name, 'reduced-motion-running')
  await waiting.getByRole('button', { name: '停止等待' }).click()
  await expect(page.getByRole('alert')).toContainText('尚未取消服务端任务')
  expect(mock.generates).toHaveLength(1)
  mock.jobStatus = 'done'
  await page.getByRole('button', { name: '继续查询' }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  await expect(page.getByText(/实际费用 ¥0.30/)).toBeVisible()
  expect(mock.generates).toHaveLength(1)
})

test('a follow-up turn carries no reference image by default', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成/)).toBeVisible()
  // The real backend reports useReference=false when no reference was sent.
  mock.plan = { prompt: '一只橘猫', size: 'auto', quality: 'medium', count: 2, useReference: false }
  await send(page, '再来一只橘猫')
  expect(mock.chats[1].reference).toBeUndefined()
  const card = page.getByRole('region', { name: '生成方案' }).last()
  await expect(card.getByText('所选图片')).toHaveCount(0)
  await expect(card.getByText('预计')).toContainText('¥0.60')
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(2)
  expect(mock.generates[1]).toMatchObject({ mode: 'reference', count: 2, references: [] })
})

test('clicking "修改这张图" brings that image in as the reference', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成/)).toBeVisible()
  await page.getByRole('button', { name: '修改这张图' }).click()
  await page.getByRole('button', { name: '不标记，直接带入对话' }).click()
  await expect(page.getByText('下一条会修改这张图')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '描述你想要的画面' })).toBeFocused()
  mock.plan = { prompt: '改成黄昏，挂上暖色灯笼', size: 'auto', quality: 'medium', count: 2, useReference: true }
  await send(page, '改成黄昏')
  expect(mock.chats[1].reference).toEqual({ prompt: '雨后江南小镇，清晨薄雾' })
  await expect(page.getByText('下一条会修改这张图')).toHaveCount(0)
  const card = page.getByRole('region', { name: '生成方案' }).last()
  await expect(card.getByText('所选图片')).toBeVisible()
  await expect(card.getByText('预计')).toContainText('¥0.30')
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(2)
  expect(mock.generates[1]).toMatchObject({ mode: 'edit', count: 1, compare: false })
  expect(mock.generates[1].references).toHaveLength(1)
  expect(mock.generates[1].references[0]).toMatch(/^data:image\//)
  // the pick is one-shot: the next message starts clean again
  await send(page, '再画一张别的')
  await expect.poll(() => mock.chats.length).toBe(3)
  expect(mock.chats[2].reference).toBeUndefined()
})

test('chat failure offers generating the original text', async ({ page }) => {
  const mock = await install(page)
  mock.chatFails = true
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '一只橘猫')
  await expect(page.getByRole('alert').filter({ hasText: '对话服务暂时不可用' })).toBeVisible()
  await page.getByRole('button', { name: /按原文直接生成/ }).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0]).toMatchObject({ prompt: '一只橘猫', count: 1 })
})

test('conversation survives a reload and stays per-account', async ({ page }) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await expect(page.getByRole('region', { name: '生成方案' })).toBeVisible()
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByText('雨后江南小镇', { exact: true }).first()).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('jianlai-chat:v1:')))).toEqual(['jianlai-chat:v1:acct-1'])
})

test('templates and video are reachable and return to chat', async ({ page }, info) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  await page.getByRole('button', { name: '灵感模板' }).click()
  await page.getByRole('button', { name: /纸艺剧场/ }).click()
  await expect(page.getByRole('textbox', { name: '描述你想要的画面' })).toHaveValue('纸艺风格的小剧场')
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  await page.getByRole('button', { name: '视频' }).click()
  await expect(page.getByRole('heading', { name: '创建视频' })).toBeVisible()
  await noOverflow(page)
})

test('gallery opens on demand and closes accessibly on desktop and mobile', async ({ page }) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  const gallery = page.getByRole('dialog', { name: '画廊面板' })
  const trigger = page.getByRole('button', { name: '打开画廊' })
  await expect(gallery).toBeHidden()
  await trigger.click()
  await expect(gallery).toBeVisible()
  await expect(gallery.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(gallery).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await gallery.getByRole('button', { name: '收起画廊' }).click()
  await expect(gallery).toBeHidden()
  await expect(trigger).toBeFocused()
  await noOverflow(page)
})

test('legacy workbench stays reachable for rollback', async ({ page }) => {
  await install(page)
  await page.goto('/?legacy=1', { waitUntil: 'networkidle' })
  await expect(page.locator('h1', { hasText: '生图工作台' })).toBeVisible()
})

const LEGACY_URL = `${OSS}old/work-0.png`
const record = {
  id: `${JOB}-0`, jobId: JOB, index: 0, image: LEGACY_URL, previewUrl: LEGACY_URL, downloadUrl: LEGACY_URL,
  prompt: '雨后江南小镇', text: '', created: Date.now(),
}
const openFirstWork = async (page: Page) => {
  await page.getByRole('button', { name: '打开画廊' }).click()
  await page.getByRole('button', { name: /查看作品/ }).first().click()
}

test('stars saved by the previous UI still show and can be removed', async ({ page }) => {
  const mock = await install(page)
  mock.history = [record]
  await page.addInitScript((url) => {
    if (!localStorage.getItem('jianlai-favorites')) localStorage.setItem('jianlai-favorites', JSON.stringify([url]))
  }, LEGACY_URL)
  await page.goto('/', { waitUntil: 'networkidle' })
  await openFirstWork(page)
  const viewer = page.getByRole('dialog')
  const star = viewer.getByRole('button', { name: '已收藏' })
  await expect(star).toBeVisible()
  await star.click()
  await expect(viewer.getByRole('button', { name: '收藏', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('jianlai-favorites'))).toBe('[]')
})

test('templates saved in the previous UI appear under 我的模板, can be used and deleted', async ({ page }, info) => {
  await install(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem('jianlai-private-templates')) {
      localStorage.setItem('jianlai-private-templates', JSON.stringify([{
        id: 'private-1', title: '我的海报', prompt: '咖啡店开业海报', text: '开业大吉', image: '', preview: '', private: true, category: 'mine',
      }]))
    }
  })
  await page.goto('/', { waitUntil: 'networkidle' })
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  await page.getByRole('button', { name: '灵感模板' }).click()
  await page.getByRole('button', { name: '我的模板', exact: true }).click()
  await page.getByRole('button', { name: /我的海报/ }).first().click()
  await expect(page.getByRole('textbox', { name: '描述你想要的画面' })).toHaveValue('咖啡店开业海报\n画面文字：「开业大吉」')
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  await page.getByRole('button', { name: '灵感模板' }).click()
  await page.getByRole('button', { name: '删除模板：我的海报' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByRole('button', { name: /^我的海报/ })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('jianlai-private-templates'))).toBe('[]')
})

test('a result can be saved as a template from the viewer', async ({ page }) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成/)).toBeVisible()
  await page.getByRole('button', { name: '放大查看' }).first().click()
  await page.getByRole('button', { name: '存为模板' }).click()
  await page.getByRole('textbox', { name: '模板名称' }).fill('江南水乡')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('已保存到我的模板')).toBeVisible()
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('jianlai-private-templates') || '[]'))
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ title: '江南水乡', prompt: '雨后江南小镇，清晨薄雾', private: true, category: 'mine' })
})

test('brand logo and assistant avatar are images, not text or icons', async ({ page }, info) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  await expect(page.getByRole('img', { name: '剑来生图' })).toBeVisible()
  const logo = page.getByRole('img', { name: '剑来生图' })
  expect(await logo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  if (info.project.name === 'mobile') {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '菜单面板' })).toBeHidden()
  }
  await send(page, '雨后江南小镇')
  const avatars = page.locator('.jl-assistant-identity img')
  expect(await avatars.count()).toBeGreaterThan(0)
  expect(await avatars.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-brand.png` })
})

test('welcome examples are sales posters; a chip sends its full prompt', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  const chips = page.getByRole('group', { name: '试试这些' }).getByRole('button')
  await expect(chips).toHaveText(['新品上市海报', '电商主图', '课程介绍图', '讲师介绍图', '销售活动海报', '业绩喜报'])
  await chips.filter({ hasText: '讲师介绍图' }).click()
  await expect.poll(() => mock.chats.length).toBe(1)
  const sent: string = mock.chats[0].messages[0].content
  expect(sent).toContain('讲师介绍图')
  expect(sent.length).toBeGreaterThan(60)
  await expect(page.getByRole('region', { name: '生成方案' })).toBeVisible()
})

test('account card shows the shared account name and the dog avatar', async ({ page }, info) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  const card = page.locator('.jl-sidebar-footer')
  await expect(card).toBeVisible()
  await expect(card.getByText('余额 ¥50.00')).toBeVisible()
  await expect(page.getByText('访客账户')).toHaveCount(0)
  const avatar = card.locator('img[width="36"][height="36"]')
  await expect(avatar).toBeVisible()
  expect(await avatar.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-account.png` })
})

// ---- bug 1: placeholders and pictures must fit small screens -------------------------------
test('the placeholder and the finished picture stay within half the screen height', async ({ page }, info) => {
  const mock = await install(page)
  mock.jobStatus = 'running'
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  const card = page.getByRole('region', { name: '生成方案' })
  await card.locator('summary').filter({ hasText: '编辑方案' }).click()
  await card.getByRole('combobox', { name: '画幅' }).click()
  await page.getByRole('option', { name: '2:3 · 竖版' }).click()
  await card.getByRole('button', { name: '生成', exact: true }).click()
  const skeleton = page.locator('.chat-skeleton').first()
  await expect(skeleton).toBeVisible()
  const viewport = page.viewportSize()!
  const box = (await skeleton.boundingBox())!
  expect(box.height).toBeLessThanOrEqual(viewport.height * 0.5 + 1)
  expect(box.width / box.height).toBeCloseTo(2 / 3, 1)
  await noOverflow(page)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-placeholder.png` })
  await businessShot(page, info.project.name, 'running')
  mock.jobStatus = 'done'
  const result = page.locator('figure img').first()
  await expect(result).toBeVisible()
  await expect.poll(() => result.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  // offsetHeight is layout size; boundingBox() includes the 1.03x entrance animation.
  const laidOut = await result.evaluate((i: HTMLImageElement) => i.offsetHeight)
  expect(laidOut).toBeLessThanOrEqual(viewport.height * 0.5 + 1)
  // The mock preview is 300x450, shown at its own size when that is below the cap.
  expect(laidOut).toBeGreaterThan(100)
})

// ---- bug 2: the ratio picker decides the canvas ---------------------------------------------
test('changing the ratio on the plan card is what gets generated', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  const card = page.getByRole('region', { name: '生成方案' })
  await card.locator('summary').filter({ hasText: '编辑方案' }).click()
  await expect(card.getByRole('combobox', { name: '画幅' })).toContainText('3:2')
  await card.getByRole('combobox', { name: '画幅' }).click()
  await page.getByRole('option', { name: '2:3 · 竖版' }).click()
  await expect(card.getByRole('combobox', { name: '画幅' })).toContainText('2:3')
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0].size).toBe('1024x1536')
})

// ---- bug 3: zoom in on a picture to see detail ----------------------------------------------
test('a picture can be opened and zoomed to its real pixels, then fitted again', async ({ page }, info) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成/)).toBeVisible()
  await page.getByRole('button', { name: '放大查看' }).first().click()
  const viewer = page.getByRole('dialog')
  const image = viewer.getByTestId('zoom-image')
  await expect(image).toHaveAttribute('src', /preview\.png/)
  await image.click()
  await expect(image).toHaveAttribute('src', /original\.png/)
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.offsetWidth)).toBe(1200)
  const box = viewer.getByTestId('zoom-box')
  expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)).toBe(true)
  await noOverflow(page)
  await page.screenshot({ path: `test-results/shots/${info.project.name}-zoom.png` })
  await viewer.getByRole('button', { name: '放大看细节' }).click()
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.offsetWidth)).toBe(2400)
  await viewer.getByRole('button', { name: '适应屏幕' }).click()
  await expect(image).toHaveAttribute('src', /preview\.png/)
  await expect(viewer.getByRole('button', { name: '缩小' })).toBeDisabled()
})

// ---- bug 4: pick the exact place to change ---------------------------------------------------
test('marks placed on the picture are sent as exact edit positions', async ({ page }, info) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成/)).toBeVisible()

  await page.getByRole('button', { name: '修改这张图' }).click()
  const dialog = page.getByRole('dialog')
  const frame = dialog.getByTestId('annotate-frame')
  const picture = frame.locator('img')
  await expect.poll(() => picture.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  const area = (await frame.boundingBox())!
  const at = (fx: number, fy: number) => ({ x: area.x + area.width * fx, y: area.y + area.height * fy })

  // 1) one point
  const point = at(0.25, 0.4)
  await page.mouse.click(point.x, point.y)
  await expect(dialog.getByRole('textbox', { name: '标记 1 的修改要求' })).toBeFocused()
  await expect(dialog.getByRole('status')).toContainText('还有 1 个标记没写修改要求')
  await expect(dialog.getByRole('button', { name: /完成标记/ })).toBeDisabled()
  await page.keyboard.type('把这里改成红色')

  // 2) one dragged box
  await dialog.getByRole('button', { name: '框选' }).click()
  const from = at(0.5, 0.5)
  const to = at(0.9, 0.8)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await expect(dialog.getByRole('textbox', { name: '标记 2 的修改要求' })).toBeFocused()
  await page.keyboard.type('背景换成黄昏')
  await page.screenshot({ path: `test-results/shots/${info.project.name}-annotate.png` })

  await dialog.getByRole('button', { name: '完成标记（2 处）' }).click()
  await expect(page.getByText('下一条会修改这张图，已标记 2 处')).toBeVisible()

  // an empty message is allowed because marks carry the instruction
  mock.plan = { prompt: '按标记修改', size: 'auto', quality: 'medium', count: 2, useReference: true }
  await page.getByRole('button', { name: '发送' }).click()
  expect(mock.chats[1].messages.at(-1).content).toBe('按标记修改这张图')
  const chatPrompt = mock.chats[1].reference.prompt
  expect(chatPrompt).toContain('雨后江南小镇，清晨薄雾')
  const chatMarks = JSON.parse(chatPrompt.split('标记修改要求（坐标为原图的0..1比例）：\n')[1])
  expect(chatMarks).toHaveLength(2)
  expect(chatMarks[0]).toMatchObject({ type: 'point', text: '把这里改成红色' })
  expect(chatMarks[0].x).toBeCloseTo(0.25, 1)
  expect(chatMarks[0].y).toBeCloseTo(0.4, 1)
  expect(chatMarks[1]).toMatchObject({ type: 'box', text: '背景换成黄昏' })
  expect(chatMarks[1].x).toBeCloseTo(0.5, 1)
  expect(chatMarks[1].y).toBeCloseTo(0.5, 1)
  expect(chatMarks[1].w).toBeCloseTo(0.4, 1)
  expect(chatMarks[1].h).toBeCloseTo(0.3, 1)
  const card = page.getByRole('region', { name: '生成方案' }).last()
  await expect(card.getByText('所选图片 · 2 处标记')).toBeVisible()
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(2)
  const sent = mock.generates[1]
  expect(sent).toMatchObject({ mode: 'edit', count: 1, compare: false })
  expect(sent.annotations).toHaveLength(2)
  expect(sent.annotations[0]).toMatchObject({ type: 'point', text: '把这里改成红色' })
  expect(sent.annotations[0].x).toBeCloseTo(0.25, 1)
  expect(sent.annotations[0].y).toBeCloseTo(0.4, 1)
  expect(sent.annotations[1]).toMatchObject({ type: 'box', text: '背景换成黄昏' })
  expect(sent.annotations[1].x).toBeCloseTo(0.5, 1)
  expect(sent.annotations[1].y).toBeCloseTo(0.5, 1)
  expect(sent.annotations[1].w).toBeCloseTo(0.4, 1)
  expect(sent.annotations[1].h).toBeCloseTo(0.3, 1)
  await noOverflow(page)
})

test('the mark editor can be reopened and a mark deleted before sending', async ({ page }) => {
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成/)).toBeVisible()
  await page.getByRole('button', { name: '修改这张图' }).click()
  const dialog = page.getByRole('dialog')
  const frame = dialog.getByTestId('annotate-frame')
  await expect.poll(() => frame.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  const a = (await frame.boundingBox())!
  await page.mouse.click(a.x + a.width * 0.3, a.y + a.height * 0.3)
  await expect(dialog.getByRole('textbox', { name: '标记 1 的修改要求' })).toBeFocused()
  await page.keyboard.type('改一下')
  await dialog.getByRole('button', { name: '完成标记（1 处）' }).click()
  await page.getByRole('button', { name: '重新标记' }).click()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '标记 1 的修改要求' })).toHaveValue('改一下')
  await page.getByRole('dialog').getByRole('button', { name: '删除标记 1' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '不标记，直接带入对话' }).click()
  await expect(page.getByText('下一条会修改这张图')).toBeVisible()
  await expect(page.getByText(/已标记/)).toHaveCount(0)
})

// ---- admin page: a two-level route must still load the bundle ---------------------------
// With a relative asset base, /manage/<path> requested /manage/assets/..., got the HTML
// fallback instead of JavaScript, and rendered a blank page.
const TEST_ADMIN = 'e2e-admin-path-0123456789abcdef'
for (const suffix of ['', '/']) {
  test(`admin page renders its login form at /manage/<path>${suffix || ' (no slash)'}`, async ({ page }) => {
    const sessions: string[] = []
    await page.route('**/api/admin/**', (route) => {
      sessions.push(new URL(route.request().url()).pathname)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false, availableCents: 30000, balanceCents: 30000, reservedCents: 0 }),
      })
    })
    const problems: string[] = []
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`))
    page.on('console', (m) => m.type() === 'error' && problems.push(`console ${m.text()}`))
    page.on('response', async (r) => {
      const type = r.headers()['content-type'] || ''
      if (/\.(js|css)$/.test(new URL(r.url()).pathname) && !/javascript|css/.test(type)) {
        problems.push(`wrong type ${type} for ${r.url()}`)
      }
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`)
    })
    await page.goto(`/manage/${TEST_ADMIN}${suffix}`, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: '登录管理工作台' })).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
    // The admin screen hard-codes the production prefix, matching the live API path.
    expect(sessions).toContain(`/jianlai/api/admin/${TEST_ADMIN}/session`)
    expect(problems).toEqual([])
  })
}

test('sending a template from the empty state leaves the relocated composer empty', async ({ page }, info) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
  await page.getByRole('button', { name: '灵感模板' }).click()
  await page.getByRole('button', { name: /纸艺剧场/ }).click()
  const input = page.getByRole('textbox', { name: '描述你想要的画面' })
  await expect(input).toHaveValue('纸艺风格的小剧场')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('region', { name: '生成方案' })).toBeVisible()
  await expect(input).toHaveValue('')
  expect(mock.chats).toHaveLength(1)
  expect(mock.generates).toHaveLength(0)
})

test('both narrow-screen result toolbars remain fully inside their image cards', async ({ page }) => {
  const mock = await install(page)
  mock.jobResponses = [{ status: 200, body: {
    id: JOB, status: 'done', phase: 'done', charged: .6, availableCents: 4940,
    images: [0, 1].map(index => ({ index, url: `${OSS}j/original-${index}.png`, previewUrl: `${OSS}j/preview-${index}.png`, downloadUrl: `${OSS}j/original-${index}.png` })),
  } }]
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '两张雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成 · 2 张/)).toBeVisible()
  const figures = page.locator('.job-card figure')
  await expect(figures).toHaveCount(2)
  for (const figure of await figures.all()) {
    await figure.scrollIntoViewIfNeeded()
    await expect(figure.getByRole('button', { name: '修改这张图', exact: true })).toBeVisible()
    expect(await figure.evaluate(element => {
      const outer = element.getBoundingClientRect()
      return [...element.querySelectorAll('button,a')].every(button => {
        const inner = button.getBoundingClientRect()
        return inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.width >= 44 && inner.height >= 44
      })
    })).toBe(true)
  }
  await noOverflow(page)
})

test('compact real plans remain usable on narrow and enlarged-text layouts', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'One pass checks all CSS viewports')
  await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  const plan = page.getByRole('region', { name: '生成方案' })
  const confirm = plan.getByRole('button', { name: '生成', exact: true })
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 })
    await confirm.scrollIntoViewIfNeeded()
    await expect(confirm).toBeInViewport()
    await noOverflow(page)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await confirm.scrollIntoViewIfNeeded()
  await expect(confirm).toBeInViewport()
  await noOverflow(page)
  await plan.locator('summary').click()
  const prompt = plan.getByRole('textbox', { name: '画面描述' })
  await prompt.fill('放大文字后仍可修改的画面')
  await expect(prompt).toHaveValue('放大文字后仍可修改的画面')
  await noOverflow(page)
})


test('visible waiting stays within its continuous animation budget and pauses when hidden', async ({ page }) => {
  const mock = await install(page)
  mock.jobStatus = 'running'
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '雨后江南小镇')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  const waiting = page.locator('.generation-waiting')
  await expect(waiting).toBeVisible()
  await expect.poll(() => waiting.getAttribute('data-motion-paused')).toBe('false')
  const loops = await waiting.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).length)
  expect(loops).toBeGreaterThan(0)
  expect(loops).toBeLessThanOrEqual(3)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(waiting).toHaveAttribute('data-motion-paused', 'true')
  await expect.poll(() => waiting.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).length)).toBe(0)
  await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await expect(waiting).toHaveAttribute('data-motion-paused', 'false')
})
