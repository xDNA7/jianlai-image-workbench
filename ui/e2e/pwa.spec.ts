import { expect, test } from '@playwright/test'

test('online-first PWA has install assets, keeps drafts on reconnect and offers updates', async ({ page, context }) => {
  let version = 'first-build'
  await page.route('**/version.json', route => route.fulfill({ json: { version } }))
  await page.goto('/design')
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifestHref).toBeTruthy()
  const manifest = await page.request.get(manifestHref!)
  expect(manifest.ok()).toBe(true)
  const data = await manifest.json()
  expect(data.scope).toBe('/jianlai/')
  expect(data.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  // The e2e server intentionally builds at /; the production manifest scope remains /jianlai/.
  for (const icon of data.icons) expect((await page.request.get(icon.src.replace(/^\/jianlai\//, '/'))).ok()).toBe(true)
  const input = page.getByRole('textbox', { name: '描述你想要的画面' })
  await input.fill('网络中断时保留我的想法')
  await context.setOffline(true)
  await expect(page.getByRole('status')).toContainText('不会自动提交或扣费')
  await expect(input).toHaveValue('网络中断时保留我的想法')
  await context.setOffline(false)
  await expect(page.getByText('网络已断开。')).not.toBeVisible()
  version = 'second-build'
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂时关闭提示' }).click()
  await expect(input).toHaveValue('网络中断时保留我的想法')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: '把想法，变成画面。' })).toBeVisible()
})
