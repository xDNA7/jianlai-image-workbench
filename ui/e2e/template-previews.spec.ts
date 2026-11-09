import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const bytes = readFileSync(new URL('../src/design/orange-example.webp', import.meta.url))
const adminPath = 'admin-template-fixture-abcdefghijklmnop'
const asset = 'api/template-assets/' + 'a'.repeat(32)
for (const role of ['user', 'admin'] as const) {
  for (const [kind, preview, expected] of [
    ['runtime', 'https://runtime-cdn.example/jianlai/templates/previews/example.webp', 'https://runtime-cdn.example/jianlai/templates/previews/example.webp'],
    ['local', 'templates/example.webp', '/jianlai/templates/example.webp'],
    ['generated', asset, '/jianlai/' + asset],
  ]) test(`${role} template preview decodes ${kind} images without a build-time asset host`, async ({ page }, info) => {
    const placeholder: string[] = []
    page.on('request', request => { if (request.url().includes('public-assets.example')) placeholder.push(request.url()) })
    await page.route('https://runtime-cdn.example/**', route => route.fulfill({ contentType: 'image/webp', body: bytes }))
    await page.route('**/jianlai/templates/**', route => route.fulfill({ contentType: 'image/webp', body: bytes }))
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      if (path.includes('/api/template-assets/')) return route.fulfill({ contentType: 'image/webp', body: bytes })
      if (path.endsWith('/session')) return json({ authenticated: true, username: 'fixture-admin', csrf: 'fixture-csrf', balance: 100, stats: {} })
      if (path.endsWith('/bootstrap')) return json({ accountId: 'template-preview', availableCents: 5000, capabilities: {} })
      if (path.endsWith('/templates')) return json({ templates: [{ id: 'example', title: '模板预览验收', prompt: '一只橘子', category: 'poster', preview }] })
      if (path.endsWith('/chat')) return json({ used: 0, limit: 50 })
      if (path.endsWith('/history') || path.endsWith('/videos')) return json({ records: [] })
      if (path.endsWith('/users')) return json({ users: [] })
      return route.fulfill({ status: 404, json: { error: 'Not found' } })
    })
    await page.goto(role === 'admin' ? `/manage/${adminPath}` : '/?view=templates')
    if (role === 'admin') await page.getByRole('button', { name: '模板管理', exact: true }).click()
    const image = role === 'admin' ? page.getByRole('img', { name: '模板预览验收', exact: true }) : page.getByRole('button', { name: '模板预览验收 销售海报', exact: true }).locator('img')
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('src', expected)
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true)
    expect(placeholder).toEqual([])
    if (kind === 'runtime') await page.screenshot({ path: info.outputPath(`${role}-templates.png`), fullPage: true })
  })
}
