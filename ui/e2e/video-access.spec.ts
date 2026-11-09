import { expect, test, type Page } from '@playwright/test'

const image = { id: 'access-image-0', jobId: 'access-image', index: 0, image: '/access-fixture.png', prompt: '公开图片作品', created: 200 }
const video = { id: 'account-video', status: 'done', prompt: '我的视频作品', created: 300, duration: 10, url: null }
const plan = { duration: 10, ratio: '16:9', resolution: '768P', shots: [{ duration: 3, scene: '雨后的窗边', camera: '慢慢推进' }, { duration: 7, scene: '咖啡杯升起热气', camera: '镜头停稳' }] }

async function install(page: Page) {
  const state = { accessCalls: 0, videoCalls: 0, chats: [] as Record<string, unknown>[], submissions: [] as Record<string, unknown>[] }
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path.endsWith('/video-access')) { state.accessCalls += 1; return respond({ error: 'not found' }, 404) }
    if (path.endsWith('/bootstrap')) return respond({ accountId: 'video-access-account', availableCents: 5000, activeJob: null, activeVideo: null, capabilities: {} })
    if (path.endsWith('/history')) return respond({ records: [image] })
    if (path.endsWith('/templates')) return respond({ templates: [] })
    if (path.includes('/videos')) {
      state.videoCalls += 1
      if (method === 'POST') {
        state.submissions.push(request.postDataJSON())
        return respond({ id: 'paid-video', status: 'running', phase: 'generating', progress: 25, duration: 10, availableCents: 3800 })
      }
      if (path.endsWith('/videos/paid-video')) return respond({ id: 'paid-video', status: 'running', phase: 'generating', progress: 25, duration: 10, availableCents: 3800 })
      return path.endsWith('/videos') ? respond({ records: [video] }) : respond(video)
    }
    if (path.endsWith('/chat') && method === 'GET') return respond({ used: 0, limit: 50 })
    if (path.endsWith('/chat') && method === 'POST') {
      const chat = request.postDataJSON()
      state.chats.push(chat)
      return route.fulfill({ contentType: 'text/event-stream', body: `event: meta\ndata: {"used":1,"limit":50}\n\nevent: storyboard\ndata: ${JSON.stringify(plan)}\n\nevent: done\ndata: {}\n\n` })
    }
    return respond({ error: 'not found' }, 404)
  })
  await page.route('**/access-fixture.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }))
  return state
}

test('video workspace is public without an additional password or access-status request', async ({ page }) => {
  const state = await install(page)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toBeVisible()
  await expect(page.getByLabel('视频访问口令', { exact: true })).toHaveCount(0)
  expect(state.accessCalls).toBe(0)
  expect(state.submissions).toHaveLength(0)
  await page.getByRole('textbox', { name: '描述你想要的视频', exact: true }).fill('雨后窗边的咖啡杯')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认分镜并生成视频', exact: true })).toBeVisible()
  expect(state.submissions).toHaveLength(0)
  await page.getByRole('button', { name: '确认分镜并生成视频', exact: true }).click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.accessCalls).toBe(0)
})

test('the unified gallery includes the current account videos without a separate login', async ({ page }) => {
  const state = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('textbox', { name: '描述你想要的画面', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开画廊', exact: true }).click()
  const gallery = page.getByRole('dialog', { name: '画廊面板' })
  await expect(gallery.getByRole('button', { name: '查看作品：公开图片作品', exact: true })).toBeVisible()
  await expect(gallery.getByRole('button', { name: '查看视频：我的视频作品', exact: true })).toBeVisible()
  expect(state.videoCalls).toBeGreaterThan(0)
  expect(state.accessCalls).toBe(0)
})
