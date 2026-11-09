import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const OSS = 'https://actual-production-oss.example/jianlai/'
const OLD_PROMPT = '旧图：江南小镇和红灯笼'
const REPLY = '已整理本次画面方案。'
const PHOTO = fileURLToPath(new URL('../src/design/orange-example.webp', import.meta.url))
const SECOND_PHOTO = fileURLToPath(new URL('../src/design/architecture-example.webp', import.meta.url))
type ChatRequest = { messages: { role: string; content: string }[]; reference?: { prompt: string } }
type GenerateRequest = { prompt: string; references: string[]; mode: string }

async function install(page: Page) {
  const mock = {
    chats: [] as ChatRequest[], generates: [] as GenerateRequest[], unexpected: [] as string[],
    useReference: false,
  }
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(`${OSS}**`, route => route.fulfill({ status: 200, contentType: 'image/webp', body: readFileSync(SECOND_PHOTO) }))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (method === 'GET' && path.endsWith('/video-access')) return json(route, { authenticated: false })
    if (method === 'GET' && path.endsWith('/bootstrap')) return json(route, {
      accountId: 'reference-context', availableCents: 5000 - mock.generates.length * 30,
      imagePriceCents: 30, activeJob: null, activeVideo: null,
      capabilities: { sizes: [{ value: 'auto', label: '自动画幅' }], qualities: [{ value: 'medium', label: '精细' }] },
    })
    if (method === 'GET' && path.endsWith('/templates')) return json(route, { templates: [
      { id: 'paper', title: '纸艺剧场', prompt: '尚未发送的纸艺模板草稿', category: 'fun', preview: 'templates/paper.webp' },
    ] })
    if (method === 'GET' && path.endsWith('/history')) return json(route, { records: mock.generates.map((g, index) => ({
      id: `${index + 1}-0`, jobId: String(index + 1).padStart(32, '0'), index: 0,
      prompt: g.prompt, created: Date.now(), image: `${OSS}context/${index + 1}/original.png`, previewUrl: `${OSS}context/${index + 1}/preview.png`,
    })) })
    if (method === 'GET' && path.endsWith('/videos')) return json(route, { records: [] })
    if (method === 'GET' && path.endsWith('/chat')) return json(route, { used: mock.chats.length, limit: 50 })
    if (method === 'POST' && path.endsWith('/chat')) {
      mock.chats.push(request.postDataJSON() as ChatRequest)
      const prompt = mock.chats.length === 1 ? OLD_PROMPT : `新方案 ${mock.chats.length}`
      const events: [string, unknown][] = [
        ['meta', { used: mock.chats.length, limit: 50 }], ['delta', { text: REPLY }],
        ['plan', { prompt, text: '', size: 'auto', quality: 'medium', count: 1, useReference: mock.useReference }], ['done', {}],
      ]
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') })
    }
    if (method === 'POST' && path.endsWith('/generate')) {
      mock.generates.push(request.postDataJSON() as GenerateRequest)
      return json(route, { id: String(mock.generates.length).padStart(32, '0'), status: 'running', phase: 'queued' }, 202)
    }
    if (/\/jobs\/[a-f0-9]{32}\/images\/0$/.test(path)) return route.fulfill({ contentType: 'image/png', body: PNG })
    const job = path.match(/\/jobs\/(\d{32})$/)
    if (method === 'GET' && job) return json(route, {
      id: job[1], status: 'done', phase: 'done', charged: 0.3, availableCents: 5000 - mock.generates.length * 30,
      images: [{ index: 0, url: `${OSS}context/${Number(job[1])}/original.png`, previewUrl: `${OSS}context/${Number(job[1])}/preview.png`, downloadUrl: `${OSS}context/${Number(job[1])}/original.png` }],
    })
    mock.unexpected.push(`${method} ${path}`)
    return json(route, { error: 'Unexpected mocked API request' }, 501)
  })
  return mock
}

const composer = (page: Page) => page.getByRole('textbox', { name: '描述你想要的画面' })
const latestPlan = (page: Page) => page.getByRole('region', { name: '生成方案' }).last()
async function send(page: Page, text: string) {
  const plansBefore = await page.getByRole('region', { name: '生成方案' }).count()
  await composer(page).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('region', { name: '生成方案' })).toHaveCount(plansBefore + 1)
  await expect(page.getByRole('button', { name: '停止回复' })).toHaveCount(0)
  await expect(latestPlan(page)).toBeVisible()
}
async function generateAndPin(page: Page) {
  await send(page, '请画旧的江南小镇')
  await latestPlan(page).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  await page.getByRole('button', { name: '修改这张图' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '不标记，直接带入对话' }).click()
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toBeVisible()
}
async function upload(page: Page, path = PHOTO) {
  await page.locator('form').filter({ has: composer(page) }).locator('input[type=file]').setInputFiles(path)
  const image = page.getByRole('img', { name: path === PHOTO ? 'orange-example.webp' : 'architecture-example.webp', exact: true })
  await expect(image).toBeVisible()
  const src = await image.getAttribute('src')
  expect(src).toMatch(/^data:image\//)
  expect(src).not.toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  return src!
}
async function openMenu(page: Page) {
  const open = page.getByRole('button', { name: '打开菜单' })
  if (await open.isVisible()) await open.click()
}
async function clear(page: Page) {
  await openMenu(page)
  await page.getByRole('button', { name: '清空对话', exact: true }).click()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '菜单面板' })).toBeHidden()
  await expect(composer(page)).toHaveValue('')
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '移除参考图' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '生成方案' })).toHaveCount(0)
}

test('a new upload replaces the explicitly picked old image in chat, preview and generation bytes', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await generateAndPin(page)
  const bytes = await upload(page)
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toHaveCount(0)
  mock.useReference = true
  await send(page, '只参考新上传的橘子照片')
  expect(mock.chats[1].messages).toEqual([{ role: 'user', content: '只参考新上传的橘子照片' }])
  expect(mock.chats[1].reference?.prompt).toContain('用户本次新上传的参考照片')
  expect(mock.chats[1].reference?.prompt).toContain('不沿用此前生成图片、人物或场景')
  expect(mock.chats[1].reference?.prompt).not.toContain(OLD_PROMPT)
  const preview = latestPlan(page).locator('[aria-label="本次方案参考图"]')
  await expect(preview).toContainText('orange-example.webp')
  await expect(preview.getByRole('img', { name: '本次方案参考图' })).toHaveAttribute('src', bytes)
  expect(mock.generates).toHaveLength(1)
  await expect(page.getByText('请画旧的江南小镇', { exact: true })).toBeVisible()
  await latestPlan(page).getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(2)
  expect(mock.generates[1]).toMatchObject({ mode: 'edit', references: [bytes] })
  expect(mock.unexpected).toEqual([])
})

test('each later upload starts a new brief and subsequent text retains only that brief', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '旧的无关画面')
  await upload(page)
  mock.useReference = true
  await send(page, '第一张照片画成橘色')
  await send(page, '让第一张再亮一点')
  expect(mock.chats[2].messages).toEqual([
    { role: 'user', content: '第一张照片画成橘色' }, { role: 'assistant', content: REPLY },
    { role: 'user', content: '让第一张再亮一点' },
  ])
  await upload(page, SECOND_PHOTO)
  await send(page, '第二张建筑照片使用蓝色')
  expect(mock.chats[3].messages).toEqual([{ role: 'user', content: '第二张建筑照片使用蓝色' }])
  await send(page, '保持第二张的主体，再增加留白')
  expect(mock.chats[4].messages).toEqual([
    { role: 'user', content: '第二张建筑照片使用蓝色' }, { role: 'assistant', content: REPLY },
    { role: 'user', content: '保持第二张的主体，再增加留白' },
  ])
  await expect(page.getByText('第一张照片画成橘色', { exact: true })).toBeVisible()
  await expect(page.getByText('旧的无关画面', { exact: true })).toBeVisible()
  expect(mock.generates).toHaveLength(0)
  expect(mock.unexpected).toEqual([])
})

test('clear removes picked images, template drafts and unsent uploads across reload while keeping artworks', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await generateAndPin(page)
  await composer(page).fill('尚未发送的修改要求')
  await clear(page)
  expect(mock.generates).toHaveLength(1)

  await send(page, '用于确认清空模板草稿的对话')
  await openMenu(page)
  await page.getByRole('button', { name: '灵感模板', exact: true }).click()
  await page.getByRole('button', { name: /纸艺剧场/ }).click()
  await expect(composer(page)).toHaveValue('尚未发送的纸艺模板草稿')
  await upload(page)
  await clear(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(composer(page)).toHaveValue('')
  await expect(page.getByRole('button', { name: '移除参考图' })).toHaveCount(0)
  await expect(page.getByText('下一条会修改这张图')).toHaveCount(0)
  await page.getByRole('button', { name: '打开画廊' }).click()
  const gallery = page.getByRole('dialog', { name: '画廊面板' })
  await expect(gallery.getByRole('button', { name: `查看作品：${OLD_PROMPT}` })).toBeVisible()
  await gallery.getByRole('button', { name: '收起画廊' }).click()
  await send(page, '清空后的全新文字画面')
  expect(mock.chats.at(-1)).toEqual({ messages: [{ role: 'user', content: '清空后的全新文字画面' }] })
  expect(mock.generates).toHaveLength(1)
  await latestPlan(page).getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(2)
  expect(mock.generates[1].references).toEqual([])
  expect(mock.unexpected).toEqual([])
})

test('an invalid replacement upload unpins the old image before the next text turn', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await generateAndPin(page)
  await page.locator('input[type=file]').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await expect(page.getByRole('alert')).toContainText('图片格式与文件内容不符')
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '移除参考图' })).toHaveCount(0)
  mock.useReference = true
  await send(page, '改为完全独立的一片森林')
  expect(mock.chats[1].reference).toBeUndefined()
  await expect(latestPlan(page).getByRole('img', { name: '本次方案参考图' })).toHaveCount(0)
  await latestPlan(page).getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => mock.generates.length).toBe(2)
  expect(mock.generates[1].references).toEqual([])
  expect(mock.unexpected).toEqual([])
})


test('two consecutive static edits read authenticated original bytes', async ({ page }) => {
  const mock = await install(page)
  const reads: string[] = []
  await page.route('**/api/jobs/*/images/0', route => { reads.push(route.request().url()); return route.fulfill({ contentType: 'image/png', body: PNG }) })
  await page.goto('/', { waitUntil: 'networkidle' })
  await generateAndPin(page)
  mock.useReference = true
  for (let round = 0; round < 2; round++) {
    await send(page, `第 ${round + 1} 次修改，把灯笼改蓝`)
    await latestPlan(page).getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => mock.generates.length).toBe(round + 2)
    await expect(page.getByText(/已完成 · 1 张/)).toHaveCount(round + 2)
    expect(mock.generates[round + 1]).toMatchObject({ mode: 'edit', references: [`data:image/png;base64,${PNG.toString('base64')}`] })
    if (round === 0) {
      await page.getByRole('button', { name: '修改这张图' }).last().click()
      await page.getByRole('dialog').getByRole('button', { name: '不标记，直接带入对话' }).click()
    }
  }
  expect(reads).toHaveLength(2)
  expect(mock.unexpected).toEqual([])
})

for (const upload of [false, true]) test(`unknown result recovers by original key after reload without ${upload ? 'lost upload memory' : 'expired original'} or POST`, async ({ page }) => {
  const mock = await install(page)
  const requestKey = 'original-request-key-1234'
  const jobId = 'a'.repeat(32)
  await page.addInitScript(({ requestKey, upload }) => localStorage.setItem('jianlai-chat:v1:reference-context', JSON.stringify([
    { type: 'job', id: 'lost-result', requestKey, status: 'unknown', images: [], started: Date.now(), created: Date.now(),
      plan: { prompt: '修改旧图', text: '', size: 'auto', quality: 'medium', count: 1, useReference: true },
      reference: upload ? { kind: 'upload', id: 'lost-upload', name: 'old.png', preview: '' } : { kind: 'picked', url: 'https://expired.example/old.png', preview: '', prompt: '旧图' } },
  ])), { requestKey, upload })
  let lookedUp = ''
  await page.route('**/api/jobs/by-request?**', route => {
    lookedUp = new URL(route.request().url()).searchParams.get('requestKey') || ''
    return route.fulfill({ contentType: 'application/json', json: { id: jobId, status: 'done', phase: 'done', charged: .3, images: [{ index: 0, url: `${OSS}original.png` }] } })
  })
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '按原请求继续提交', exact: true }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(lookedUp).toBe(requestKey)
  expect(mock.generates).toHaveLength(0)
  expect(mock.unexpected).toEqual([])
})


test('reference read failure creates no task and shows the true client failure source', async ({ page }) => {
  const mock = await install(page)
  await page.route('**/api/jobs/*/images/0', route => route.abort('failed'))
  await page.goto('/', { waitUntil: 'networkidle' })
  await generateAndPin(page)
  mock.useReference = true
  await send(page, '把灯笼改蓝')
  await latestPlan(page).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('未提交，未扣费：无法读取参考图，请重试或重新上传')
  await expect(page.getByRole('alert')).toContainText('未创建生成任务')
  await expect(page.getByRole('alert')).not.toContainText('服务端确认失败')
  expect(mock.generates).toHaveLength(1)
})
