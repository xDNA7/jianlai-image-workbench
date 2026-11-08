import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

const shieldDog = readFileSync(new URL('../src/assets/account-avatar.webp', import.meta.url))

async function expectShieldDog(page: Page, image: Locator) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => {
    const img = element as HTMLImageElement
    return img.complete && img.naturalWidth > 0
  })).toBe(true)
  const response = await page.request.get(await image.evaluate(element => (element as HTMLImageElement).currentSrc))
  expect(response.ok()).toBe(true)
  expect(await response.body()).toEqual(shieldDog)
}

test('my shield account and Jianlai assistant share the existing shield dog avatar', async ({ page, isMobile }) => {
  const writes: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`)
    if (path.endsWith('/bootstrap')) return json({
      accountId: 'brand-fixture-account', availableCents: 5000, imagePriceCents: 30,
      activeJob: null, activeVideo: null,
      capabilities: { sizes: [{ value: 'auto', label: '自动画幅' }], qualities: [{ value: 'medium', label: '精细' }] },
    })
    if (path.endsWith('/templates')) return json({ templates: [] })
    if (path.endsWith('/history') || path.endsWith('/videos')) return json({ records: [] })
    if (path.endsWith('/chat') && request.method() === 'GET') return json({ used: 0, limit: 50 })
    if (path.endsWith('/chat') && request.method() === 'POST') return route.fulfill({
      contentType: 'text/event-stream',
      body: [
        'event: meta\ndata: {"used":1,"limit":50}\n\n',
        'event: delta\ndata: {"text":"我会保留剑来这个名字。"}\n\n',
        'event: done\ndata: {}\n\n',
      ].join(''),
    })
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected brand fixture endpoint: ${path}` }) })
  })
  await page.goto('/')
  if (isMobile) await page.getByRole('button', { name: '打开菜单', exact: true }).click()
  const account = page.locator('.jl-account')
  await expect(account.getByText('我的刀盾', { exact: true })).toBeVisible()
  await expect(account).not.toContainText('共享账户')
  await expectShieldDog(page, account.locator('img'))
  if (isMobile) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '菜单面板' })).toHaveCount(0)
  }
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('请介绍一下自己')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const assistant = page.locator('.jl-assistant-identity').first()
  await expect(assistant.getByText('剑来', { exact: true })).toBeVisible()
  await expect(assistant.getByText('创作助手', { exact: true })).toBeVisible()
  await expectShieldDog(page, assistant.locator('img'))
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatch(/^POST .*\/api\/chat$/)
})
