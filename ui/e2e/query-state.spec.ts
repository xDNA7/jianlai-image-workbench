import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const accountId = 'query-account'
const bootstrap = {
  accountId, availableCents: 5000, imagePriceCents: 30,
  capabilities: { sizes: [{ value: 'auto', label: '自动' }], qualities: [{ value: 'medium', label: '精细' }] },
}
const record = (id: string) => ({ id, jobId: id, index: 0, prompt: id, image: '/fixture.png', created: 1 })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function reconnectStaleQueries(page: Page) {
  await page.clock.setFixedTime(new Date(Date.now() + 31_000))
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
  })
}

test('gallery refresh failures expose retry even with cached works, and retry replaces the cache', async ({ page }) => {
  await page.clock.install()
  let failHistory = false
  let history = [record('旧作品')]
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/history') && failHistory) {
      await route.fulfill({ status: 503, json: { error: '暂时失败' } })
      return
    }
    const body = path.endsWith('/bootstrap') ? bootstrap
      : path.endsWith('/history') ? { records: history }
      : path.endsWith('/chat') ? { used: 0, limit: 50 } : {}
    await route.fulfill({ json: body })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '打开画廊' }).click()
  await expect(page.getByRole('button', { name: '查看作品：旧作品' })).toBeVisible()
  failHistory = true
  await reconnectStaleQueries(page)
  await expect(page.getByText('画廊加载失败')).toBeVisible()
  history = [record('重试后的作品')]
  failHistory = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('button', { name: '查看作品：重试后的作品' })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看作品：旧作品' })).toHaveCount(0)
})

test('late bootstrap refresh cannot overwrite the balance reported by a completed job', async ({ page }, info) => {
  await page.clock.install()
  const jobResponse = deferred()
  const bootstrapResponse = deferred()
  let boots = 0
  let completed = false
  await page.addInitScript((id) => {
    const plan = { prompt: '余额更新', text: '', size: 'auto', quality: 'medium', count: 1, useReference: false }
    localStorage.setItem(`jianlai-chat:v1:${id}`, JSON.stringify([
      { type: 'job', id: 'job-card', jobId: 'balance-job', requestKey: 'balance-key', status: 'running', plan, images: [], started: Date.now(), created: 1 },
    ]))
  }, accountId)
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/bootstrap')) {
      boots++
      if (boots > 1) await bootstrapResponse.promise
      await route.fulfill({ json: bootstrap })
      return
    }
    if (path.endsWith('/jobs/balance-job')) {
      await jobResponse.promise
      completed = true
      await route.fulfill({ json: { id: 'balance-job', status: 'done', charged: .3, availableCents: 4970, images: [] } })
      return
    }
    await route.fulfill({ json: path.endsWith('/chat') ? { used: 0, limit: 50 } : { records: [] } })
  })
  try {
    await page.goto('/')
    await expect(page.getByRole('button', { name: '停止等待' })).toBeVisible()
    await reconnectStaleQueries(page)
    await expect.poll(() => boots).toBe(2)
    jobResponse.resolve()
    await expect.poll(() => completed).toBe(true)
    await expect(page.getByText(/已完成/)).toBeVisible()
    if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开菜单' }).click()
    await expect(page.getByText('余额 ¥49.70', { exact: true })).toBeVisible()
    bootstrapResponse.resolve()
    // Let the stale HTTP response settle; the Query cancellation must discard it.
    await page.waitForTimeout(100)
    await expect(page.getByText('余额 ¥49.70', { exact: true })).toBeVisible()
  } finally {
    jobResponse.resolve()
    bootstrapResponse.resolve()
  }
})
