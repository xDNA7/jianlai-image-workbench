import { expect, test, type Page } from '@playwright/test'

const jobId = 'video-regression'
const video = { id: jobId, status: 'running', phase: 'generating', progress: 25, duration: 10, ratio: '16:9', prompt: '雨后窗边的咖啡杯', availableCents: 3800 }
const defaultPlan = { duration: 10, ratio: '16:9', resolution: '768P', shots: [{ duration: 3, scene: '雨后的窗边', camera: '慢慢推进' }, { duration: 7, scene: '咖啡杯升起热气', camera: '镜头停稳' }] }
type Lookup = 'found' | 'missing' | 'unavailable' | 'done'
async function install(page: Page, restore: boolean, dropFirst = false) {
  const submissions: Record<string, unknown>[] = [], chats: Record<string, unknown>[] = []
  let finished = false, lookup: Lookup = 'found', account = 'video-account', quota = 5000, chatFails = false, failVideo = false
  let last = { ...video }
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    let body: unknown
    if (path.endsWith('/video-access')) body = { authenticated: true }
    else if (path.endsWith('/bootstrap')) body = { accountId: account, availableCents: quota, activeVideo: restore ? last : null, activeJob: null, capabilities: {} }
    else if (path.endsWith('/history') || path.endsWith('/templates')) body = { records: [], templates: [] }
    else if (path.endsWith('/chat') && request.method() === 'POST') {
      const chat = request.postDataJSON(); chats.push(chat)
      if (chatFails) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '分镜供应商暂时不可用' }) })
      const content = chat.messages.at(-1).content as string
      const plan = /20|二十/.test(content) ? { ...defaultPlan, duration: 15, shots: [{ ...defaultPlan.shots[0], duration: 5 }, { ...defaultPlan.shots[1], duration: 10 }], notice: '最多一次性生成 15 秒的画面，已将内容优化为 15 秒分镜。' } : defaultPlan
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: meta\ndata: {"used":1,"limit":50}\n\nevent: delta\ndata: {"text":"我把内容整理成连续镜头。"}\n\nevent: storyboard\ndata: ${JSON.stringify(plan)}\n\nevent: done\ndata: {}\n\n` })
    } else if (path.endsWith('/chat')) body = { used: 0, limit: 50 }
    else if (path.endsWith('/videos') && request.method() === 'POST') {
      const payload = request.postDataJSON(); submissions.push(payload); last = { ...last, status: 'running', prompt: payload.prompt, duration: payload.duration }
      if (dropFirst && submissions.length === 1) return route.abort('failed')
      body = failVideo ? { ...last, status: 'failed', error: '供应商拒绝任务，额度已退回' } : last
      failVideo = false
    } else if (path.endsWith('/videos/by-request')) {
      if (lookup === 'missing' || lookup === 'unavailable') return route.fulfill({ status: lookup === 'missing' ? 404 : 503, contentType: 'application/json', body: JSON.stringify({ error: 'lookup unavailable' }) })
      body = lookup === 'done' ? { ...last, status: 'done', chargedCents: 1200, url: 'https://media.example/video.mp4' } : last
    } else if (path.endsWith(`/videos/${jobId}`)) body = finished ? { ...last, status: 'done', chargedCents: 1200, url: 'https://media.example/video.mp4' } : last
    else if (path.endsWith('/videos')) body = { records: [] }
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.route('https://media.example/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }))
  return { submissions, chats, finish: () => { finished = true }, setLookup: (value: Lookup) => { lookup = value }, setQuota: (value: number) => { quota = value }, setAccount: (value: string) => { account = value }, failChat: () => { chatFails = true }, failNextVideo: () => { failVideo = true } }
}
async function compose(page: Page, text = video.prompt) {
  await page.getByRole('textbox', { name: '描述你想要的视频' }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认分镜并生成视频', exact: true })).toBeEnabled()
}
const confirm = (page: Page) => page.getByRole('button', { name: '确认分镜并生成视频', exact: true }).click()

test('video conversation defaults to ten seconds and only confirmation creates one paid task', async ({ page }, info) => {
  const mock = await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: '创建视频' })).toBeVisible()
  await compose(page)
  expect(mock.submissions).toHaveLength(0)
  expect(mock.chats[0]).toMatchObject({ mode: 'video', video: { duration: 10 } })
  await expect(page.getByLabel('视频总时长')).toHaveValue('10')
  await expect(page.getByText('预计 ¥12.00 · ¥1.20 / 秒', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('video-storyboard.png'), fullPage: true, animations: 'disabled' })
  await page.getByLabel('镜头1画面').fill('修改后的窗边画面')
  await confirm(page)
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(1)
  expect(mock.submissions[0]).toMatchObject({ duration: 10, ratio: '16:9', resolution: '768P', image: '' })
  expect(String(mock.submissions[0].prompt)).toContain('修改后的窗边画面')
  expect(String(mock.submissions[0].requestKey)).toMatch(/^[0-9a-f-]{36}$/)
})
test('requests over fifteen seconds display the explicit limit and optimized timeline', async ({ page }) => {
  const mock = await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await compose(page, '做一段20秒的城市视频')
  await expect(page.getByRole('note')).toContainText('最多一次性生成 15 秒')
  await expect(page.getByLabel('视频总时长')).toHaveValue('15')
  await expect(page.getByText('预计 ¥18.00 · ¥1.20 / 秒', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(0)
  await confirm(page)
  await expect.poll(() => mock.submissions.length).toBe(1)
  expect(mock.submissions[0].duration).toBe(15)
})
test('active video task restores without resubmission and completes in the unified gallery', async ({ page }) => {
  const mock = await install(page, true)
  await page.clock.install()
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  mock.finish(); await page.clock.fastForward(10_001)
  await expect(page.getByText('生成完成 · 10 秒', { exact: true })).toBeVisible()
  await expect(page.getByText('已扣 ¥12.00 · 已保存到作品画廊', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(0)
})
test('accepted video with a lost POST response recovers by key without another POST', async ({ page }) => {
  const mock = await install(page, false, true)
  await page.goto('/?view=video', { waitUntil: 'networkidle' }); await compose(page); await confirm(page)
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(1)
  await expect(page.getByRole('button', { name: '核对上次提交', exact: true })).toHaveCount(0)
})
test('unknown video only retries the same compiled input with its original request key', async ({ page }) => {
  const mock = await install(page, false, true); mock.setLookup('missing')
  await page.goto('/?view=video', { waitUntil: 'networkidle' }); await compose(page); await confirm(page)
  await expect(page.getByRole('alert')).toContainText('上次视频提交结果尚未确认')
  const saved = await page.evaluate(() => sessionStorage.getItem('jianlai:pending-video:video-account'))
  expect(Object.keys(JSON.parse(saved!)).sort()).toEqual(['hash', 'key']); expect(saved).not.toContain(video.prompt)
  await page.getByLabel('镜头1画面').fill('修改后的输入'); await confirm(page)
  await expect(page.getByRole('alert')).toContainText('不能更换输入再次提交'); expect(mock.submissions).toHaveLength(1)
  await page.getByLabel('镜头1画面').fill(defaultPlan.shots[0].scene); await confirm(page)
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(2); expect(mock.submissions[1].requestKey).toBe(mock.submissions[0].requestKey)
})
test('refresh resolves a saved video key to a completed result without submitting', async ({ page }) => {
  const mock = await install(page, false, true); mock.setLookup('unavailable')
  await page.goto('/?view=video', { waitUntil: 'networkidle' }); await compose(page); await confirm(page)
  await expect(page.getByRole('alert')).toContainText('上次视频提交结果尚未确认')
  mock.setLookup('done'); await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByText('生成完成 · 10 秒', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(1)
  expect(await page.evaluate(() => sessionStorage.getItem('jianlai:pending-video:video-account'))).toBeNull()
})
test('failed storyboard chat cannot start a paid task and can retry independently', async ({ page }) => {
  const mock = await install(page, false); mock.failChat()
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: '描述你想要的视频' }).fill(video.prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('分镜供应商暂时不可用')
  await expect(page.getByRole('button', { name: '确认分镜并生成视频', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '重试分镜' }).click()
  await expect.poll(() => mock.chats.length).toBe(2); expect(mock.submissions).toHaveLength(0)
})
test('insufficient balance blocks confirmation without creating a paid task', async ({ page }) => {
  const mock = await install(page, false); mock.setQuota(500)
  await page.goto('/?view=video', { waitUntil: 'networkidle' }); await compose(page); await confirm(page)
  await expect(page.getByRole('alert')).toContainText('余额不足'); expect(mock.submissions).toHaveLength(0)
})
test('switching accounts cannot restore another account storyboard or pending key', async ({ page }) => {
  const mock = await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' }); await compose(page)
  mock.setAccount('another-video-account'); await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: '创建视频' })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认分镜并生成视频' })).toHaveCount(0)
  expect(mock.submissions).toHaveLength(0)
})

test('a failed refunded video unlocks the same storyboard for a new confirmed attempt', async ({ page }) => {
  const mock = await install(page, false); mock.failNextVideo()
  await page.goto('/?view=video', { waitUntil: 'networkidle' }); await compose(page); await confirm(page)
  await expect(page.getByRole('alert')).toContainText('额度已退回')
  await expect(page.getByRole('button', { name: '确认分镜并生成视频', exact: true })).toBeEnabled()
  await confirm(page)
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(2)
  expect(mock.submissions[1].requestKey).not.toBe(mock.submissions[0].requestKey)
})
test('stopping a pending storyboard response never creates a confirmable paid plan', async ({ page }) => {
  const mock = await install(page, false)
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/chat', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    await held
    await route.fulfill({ contentType: 'text/event-stream', body: `event: storyboard\ndata: ${JSON.stringify(defaultPlan)}\n\nevent: done\ndata: {}\n\n` }).catch(() => undefined)
  })
  try {
    await page.goto('/?view=video', { waitUntil: 'networkidle' })
    await page.getByRole('textbox', { name: '描述你想要的视频' }).fill(video.prompt)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '停止回复', exact: true }).click()
    release()
    await expect(page.getByText('已停止回复，尚未提交视频任务。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '确认分镜并生成视频' })).toHaveCount(0)
    expect(mock.submissions).toHaveLength(0)
  } finally { release() }
})
test('video first frame and followup edits survive the storyboard confirmation boundary', async ({ page }) => {
  const mock = await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256; const context = canvas.getContext('2d')!; context.fillStyle = '#777'; context.fillRect(0, 0, 256, 256); return canvas.toDataURL('image/png').split(',')[1] })
  await page.locator('input[type=file]').setInputFiles({ name: 'first-frame.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await compose(page)
  await expect(page.getByAltText('视频首帧', { exact: true })).toBeVisible()
  await page.getByLabel('视频总时长').selectOption('12')
  await page.getByLabel('视频清晰度').selectOption('2K')
  await compose(page, '让镜头更慢一些')
  expect(mock.chats[1]).toMatchObject({ video: { duration: 12, ratio: '16:9', resolution: '2K' } })
  expect(mock.submissions).toHaveLength(0)
  await confirm(page)
  await expect.poll(() => mock.submissions.length).toBe(1)
  expect(String(mock.submissions[0].image)).toMatch(/^data:image\/png;base64,/)
})


test('shot editing keeps one paid video and its total duration while preserving order', async ({ page }, info) => {
  const mock = await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await compose(page)
  const shots = page.getByRole('list', { name: '视频分镜镜头' })
  await expect(shots.getByRole('listitem')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const editor = await page.locator('.jl-video-editor').boundingBox()
  const dialogue = await page.locator('.jl-video-dialogue').boundingBox()
  expect(editor && dialogue).toBeTruthy()
  if (info.project.name === 'desktop') expect(editor!.x + editor!.width).toBeLessThanOrEqual(dialogue!.x + 1)
  else expect(dialogue!.y + dialogue!.height).toBeLessThanOrEqual(editor!.y + 1)
  await page.screenshot({ path: info.outputPath('nomi-video-workspace.png'), fullPage: true, animations: 'disabled' })
  await expect(page.getByRole('button', { name: '镜头1上移', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '镜头2下移', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '镜头1下移', exact: true }).click()
  await expect(page.getByLabel('镜头1画面', { exact: true })).toHaveValue(defaultPlan.shots[1].scene)
  await expect(page.getByLabel('镜头2画面', { exact: true })).toHaveValue(defaultPlan.shots[0].scene)
  await page.getByRole('button', { name: '镜头1复制', exact: true }).click()
  await expect(shots.getByRole('listitem')).toHaveCount(3)
  await expect(page.getByLabel('视频总时长')).toHaveValue('10')
  await page.getByLabel('镜头2画面', { exact: true }).fill('复制镜头的独立编辑')
  await expect(page.getByLabel('镜头1画面', { exact: true })).toHaveValue(defaultPlan.shots[1].scene)
  await page.getByRole('button', { name: '镜头3删除', exact: true }).click()
  await expect(shots.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByLabel('视频总时长')).toHaveValue('10')
  await expect(page.getByText('预计 ¥12.00 · ¥1.20 / 秒', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(0)
  await confirm(page)
  await expect.poll(() => mock.submissions.length).toBe(1)
  expect(mock.submissions[0].duration).toBe(10)
  expect(String(mock.submissions[0].prompt)).toContain(defaultPlan.shots[1].scene)
  expect(String(mock.submissions[0].prompt)).toContain('复制镜头的独立编辑')
  expect(String(mock.submissions[0].prompt)).not.toContain(defaultPlan.shots[0].scene)
})

test('shot editing respects the six-shot limit and always retains at least one shot', async ({ page }) => {
  await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await compose(page)
  const shots = page.getByRole('list', { name: '视频分镜镜头' })
  for (let count = 2; count < 6; count += 1) await page.getByRole('button', { name: '镜头1复制', exact: true }).click()
  await expect(shots.getByRole('listitem')).toHaveCount(6)
  for (let index = 1; index <= 6; index += 1) await expect(page.getByRole('button', { name: `镜头${index}复制`, exact: true })).toBeDisabled()
  await expect(page.getByLabel('视频总时长')).toHaveValue('10')
  for (let count = 6; count > 1; count -= 1) await page.getByRole('button', { name: '镜头1删除', exact: true }).click()
  await expect(shots.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '镜头1删除', exact: true })).toBeDisabled()
  await expect(page.getByLabel('视频总时长')).toHaveValue('10')
})
