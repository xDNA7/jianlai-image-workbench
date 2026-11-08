import { expect, test, type Page } from '@playwright/test'

const jobId = 'video-regression'
const video = { id: jobId, status: 'running', phase: 'generating', progress: 25, duration: 5, ratio: '16:9', prompt: '雨后窗边的咖啡杯', availableCents: 4400 }

type Lookup = 'found' | 'missing' | 'unavailable' | 'done'

async function install(page: Page, restore: boolean, dropFirst = false) {
  const submissions: Record<string, unknown>[] = []
  let finished = false
  let lookup: Lookup = 'found'
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let body: unknown
    if (path.endsWith('/bootstrap')) {
      body = { accountId: 'video-account', availableCents: 5000, activeVideo: restore ? video : null, activeJob: null, capabilities: {} }
    } else if (path.endsWith('/history') || path.endsWith('/templates')) {
      body = { records: [], templates: [] }
    } else if (path.endsWith('/chat')) {
      body = { used: 0, limit: 50 }
    } else if (path.endsWith('/videos') && request.method() === 'POST') {
      submissions.push(request.postDataJSON())
      if (dropFirst && submissions.length === 1) return route.abort('failed')
      body = video
    } else if (path.endsWith('/videos/by-request')) {
      if (lookup === 'missing' || lookup === 'unavailable') return route.fulfill({
        status: lookup === 'missing' ? 404 : 503,
        contentType: 'application/json', body: JSON.stringify({ error: 'lookup unavailable' }),
      })
      body = lookup === 'done' ? { ...video, status: 'done', chargedCents: 600, url: 'https://media.example/video.mp4' } : video
    } else if (path.endsWith(`/videos/${jobId}`)) {
      body = finished ? { ...video, status: 'done', chargedCents: 600, url: 'https://media.example/video.mp4' } : video
    } else if (path.endsWith('/videos')) {
      body = { records: [] }
    } else {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.route('https://media.example/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }))
  return { submissions, finish: () => { finished = true }, setLookup: (value: Lookup) => { lookup = value } }
}

test('dedicated video surface submits once and keeps paid task progress', async ({ page }) => {
  const mock = await install(page, false)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: '创建视频' })).toBeVisible()
  await page.getByRole('textbox', { name: '描述画面' }).fill(video.prompt)
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  await expect(page.getByRole('button', { name: '生成中', exact: true })).toBeDisabled()
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(1)
  expect(mock.submissions[0]).toMatchObject({ prompt: video.prompt, duration: 5, ratio: '16:9', resolution: '768P', image: '' })
  expect(mock.submissions[0].requestKey).toEqual(expect.any(String))
  expect(String(mock.submissions[0].requestKey)).toMatch(/^[0-9a-f-]{36}$/)
})

test('dedicated video surface restores the active server task without resubmission', async ({ page }) => {
  const mock = await install(page, true)
  await page.clock.install()
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '生成中', exact: true })).toBeDisabled()
  mock.finish()
  await page.clock.fastForward(10_001)
  await expect(page.getByText('生成完成 · 5 秒', { exact: true })).toBeVisible()
  await expect(page.getByText('已扣 ¥6.00', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(0)
})


test('accepted video with a lost POST response is recovered by key without another POST', async ({ page }) => {
  const mock = await install(page, false, true)
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: '描述画面' }).fill(video.prompt)
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '生成中', exact: true })).toBeDisabled()
  expect(mock.submissions).toHaveLength(1)
  await expect(page.getByRole('button', { name: '核对上次提交', exact: true })).toHaveCount(0)
})

test('unconfirmed video permits only the same input and reuses its original request key after 404', async ({ page }) => {
  const mock = await install(page, false, true)
  mock.setLookup('missing')
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: '描述画面' }).fill(video.prompt)
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('上次视频提交结果尚未确认')
  const saved = await page.evaluate(() => sessionStorage.getItem('jianlai:pending-video:video-account'))
  expect(saved).not.toBeNull()
  expect(Object.keys(JSON.parse(saved!)).sort()).toEqual(['hash', 'key'])
  expect(saved).not.toContain(video.prompt)
  await page.getByRole('textbox', { name: '描述画面' }).fill('更换后的输入')
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('不能更换输入再次提交')
  expect(mock.submissions).toHaveLength(1)
  await page.getByRole('textbox', { name: '描述画面' }).fill(video.prompt)
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(2)
  expect(mock.submissions[1].requestKey).toBe(mock.submissions[0].requestKey)
})

test('refresh reconciles a saved video request to its completed result without resubmitting', async ({ page }) => {
  const mock = await install(page, false, true)
  mock.setLookup('unavailable')
  await page.goto('/?view=video', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: '描述画面' }).fill(video.prompt)
  await page.getByRole('button', { name: '生成视频', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('上次视频提交结果尚未确认')
  mock.setLookup('done')
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByText('生成完成 · 5 秒', { exact: true })).toBeVisible()
  await expect(page.getByText('已扣 ¥6.00', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeVisible()
  expect(mock.submissions).toHaveLength(1)
  expect(await page.evaluate(() => sessionStorage.getItem('jianlai:pending-video:video-account'))).toBeNull()
})
