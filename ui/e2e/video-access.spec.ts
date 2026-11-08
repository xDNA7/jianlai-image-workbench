import { expect, test, type Page } from '@playwright/test'

const password = 'local-fixture-video-password'
const image = { id: 'access-image-0', jobId: 'access-image', index: 0, image: '/access-fixture.png', prompt: '公开图片作品', created: 200 }
const video = { id: 'internal-video', status: 'done', prompt: '内部视频作品', created: 300, duration: 10, url: null }
const plan = { duration: 10, ratio: '16:9', resolution: '768P', shots: [{ duration: 3, scene: '雨后的窗边', camera: '慢慢推进' }, { duration: 7, scene: '咖啡杯升起热气', camera: '镜头停稳' }] }

async function install(page: Page, authenticated = false) {
  const state = { authenticated, loginCalls: 0, logoutCalls: 0, videoCalls: 0, statusFails: false, chats: [] as Record<string, unknown>[], submissions: [] as Record<string, unknown>[] }
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path.endsWith('/video-access')) {
      if (method === 'GET') return state.statusFails ? respond({ error: '内部访问状态暂时不可用' }, 503) : respond({ authenticated: state.authenticated })
      if (method === 'POST') {
        state.loginCalls += 1
        if (request.postDataJSON().password !== password) return respond({ error: '视频访问口令不正确' }, 401)
        state.authenticated = true
        return respond({ authenticated: true })
      }
      if (method === 'DELETE') { state.logoutCalls += 1; state.authenticated = false; return respond({ authenticated: false }) }
    }
    if (path.endsWith('/bootstrap')) return respond({ accountId: 'video-access-account', availableCents: 5000, activeJob: null, activeVideo: null, capabilities: {} })
    if (path.endsWith('/history')) return respond({ records: [image] })
    if (path.endsWith('/templates')) return respond({ templates: [] })
    if (path.includes('/videos')) {
      state.videoCalls += 1
      if (!state.authenticated) return respond({ error: '请先验证内部视频访问口令' }, 401)
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
      if (chat.mode === 'video' && !state.authenticated) return respond({ error: '请先验证内部视频访问口令' }, 401)
      return route.fulfill({ contentType: 'text/event-stream', body: `event: meta\ndata: {"used":1,"limit":50}\n\nevent: storyboard\ndata: ${JSON.stringify(plan)}\n\nevent: done\ndata: {}\n\n` })
    }
    return respond({ error: 'not found' }, 404)
  })
  await page.route('**/access-fixture.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }))
  return state
}

async function login(page: Page) {
  await page.getByLabel('视频访问口令', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入视频工作台', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toBeVisible()
}

test('public image tools and image gallery remain available without internal video access', async ({ page }) => {
  const state = await install(page)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByLabel('视频访问口令', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toHaveCount(0)
  expect(state.videoCalls).toBe(0)
  expect(state.chats).toHaveLength(0)
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('textbox', { name: '描述你想要的画面', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开画廊', exact: true }).click()
  const gallery = page.getByRole('dialog', { name: '画廊面板' })
  await expect(gallery.getByRole('button', { name: '查看作品：公开图片作品', exact: true })).toBeVisible()
  await expect(gallery.getByRole('button', { name: /查看视频：/ })).toHaveCount(0)
  expect(state.videoCalls).toBe(0)
})

test('wrong video password keeps paid actions locked and successful login allows one confirmed task', async ({ page }) => {
  const state = await install(page)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  const field = page.getByLabel('视频访问口令', { exact: true })
  await expect(field).toHaveAttribute('type', 'password')
  await field.fill('incorrect-password')
  await page.getByRole('button', { name: '进入视频工作台', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('视频访问口令不正确')
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toHaveCount(0)
  expect(state.videoCalls).toBe(0)
  expect(state.submissions).toHaveLength(0)
  await login(page)
  expect(state.loginCalls).toBe(2)
  await page.getByRole('textbox', { name: '描述你想要的视频', exact: true }).fill('雨后窗边的咖啡杯')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('预计 ¥12.00 · ¥1.20 / 秒', { exact: true })).toBeVisible()
  expect(state.submissions).toHaveLength(0)
  await page.getByRole('button', { name: '确认分镜并生成视频', exact: true }).click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.submissions[0]).toMatchObject({ duration: 10, ratio: '16:9', resolution: '768P' })
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(password)
})

test('logout removes the video workspace and cached video gallery while preserving public images', async ({ page }) => {
  const state = await install(page, true)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开画廊', exact: true }).click()
  const gallery = page.getByRole('dialog', { name: '画廊面板' })
  await expect(gallery.getByRole('button', { name: '查看视频：内部视频作品', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  const pending = JSON.stringify({ key: '11111111-1111-4111-8111-111111111111', hash: 'a'.repeat(64) })
  await page.evaluate(value => sessionStorage.setItem('jianlai:pending-video:video-access-account', value), pending)
  await page.getByRole('button', { name: '退出内部视频', exact: true }).click()
  await expect(page.getByLabel('视频访问口令', { exact: true })).toBeVisible()
  expect(state.logoutCalls).toBe(1)
  expect(await page.evaluate(() => sessionStorage.getItem('jianlai:pending-video:video-access-account'))).toBe(pending)
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toHaveCount(0)
  const callsAtLogout = state.videoCalls
  await page.getByRole('button', { name: '打开画廊', exact: true }).click()
  await expect(gallery.getByRole('button', { name: '查看作品：公开图片作品', exact: true })).toBeVisible()
  await expect(gallery.getByRole('button', { name: /查看视频：/ })).toHaveCount(0)
  expect(state.videoCalls).toBe(callsAtLogout)
})

test('expired internal session closes the selected player and clears private gallery on a 401', async ({ page }) => {
  const state = await install(page, true)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '打开画廊', exact: true }).click()
  await page.getByRole('button', { name: '查看视频：内部视频作品', exact: true }).click()
  const preview = page.getByRole('dialog', { name: '视频作品预览' })
  await expect(preview).toBeVisible()
  state.authenticated = false
  await preview.getByRole('button', { name: '更新视频链接', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByRole('button', { name: /查看视频：/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('视频访问口令', { exact: true })).toBeVisible()
  await expect(page.getByText('视频登录已过期，请重新输入访问口令', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toHaveCount(0)
})

test('video storyboard 401 returns to the gate without creating a paid task', async ({ page }) => {
  const state = await install(page, true)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toBeVisible()
  state.authenticated = false
  await page.getByRole('textbox', { name: '描述你想要的视频', exact: true }).fill('仅内部可见的视频想法')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('视频访问口令', { exact: true })).toBeVisible()
  await expect(page.getByText('视频登录已过期，请重新输入访问口令', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认分镜并生成视频', exact: true })).toHaveCount(0)
  expect(state.submissions).toHaveLength(0)
})

test('failed access-status recheck hides cached private videos instead of keeping the workspace open', async ({ page }) => {
  await page.clock.install()
  const state = await install(page, true)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开画廊', exact: true }).click()
  await expect(page.getByRole('button', { name: '查看视频：内部视频作品', exact: true })).toBeVisible()
  state.statusFails = true
  await page.clock.fastForward(30_001)
  await expect(page.getByRole('button', { name: /查看视频：/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: '描述你想要的视频', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('内部访问状态暂时不可用')
  const callsWhileLocked = state.videoCalls
  state.statusFails = false
  state.authenticated = false
  await page.getByRole('button', { name: '重新核对访问权限', exact: true }).click()
  await expect(page.getByLabel('视频访问口令', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(state.videoCalls).toBe(callsWhileLocked)
})
