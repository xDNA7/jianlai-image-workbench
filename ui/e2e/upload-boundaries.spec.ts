import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function fixture(page: Page) {
  const posts: unknown[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = {}
    if (path.endsWith('/bootstrap')) body = { accountId: 'upload-account', availableCents: 5000, imagePriceCents: 30, capabilities: { sizes: [], qualities: [] } }
    else if (path.endsWith('/history') || path.endsWith('/videos')) body = { records: [] }
    else if (path.endsWith('/chat') && route.request().method() === 'GET') body = { used: 0, limit: 50 }
    else if (path.endsWith('/chat')) {
      posts.push(route.request().postDataJSON())
      const plan = { prompt: '上传测试', size: 'auto', quality: 'medium', count: 1, useReference: true }
      await route.fulfill({ contentType: 'text/event-stream', body: `event: plan\ndata: ${JSON.stringify(plan)}\n\nevent: done\ndata: {}\n\n` })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '描述你想要的画面' })).toBeVisible()
  return posts
}

const png = async (page: Page, side = 8) => Buffer.from(await page.evaluate(size => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#245678'; ctx.fillRect(0, 0, size, size)
  return canvas.toDataURL('image/png').split(',')[1]
}, side), 'base64')

for (const invalid of [
  { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), message: '图片已损坏' },
  { name: 'wrong.png', mimeType: 'image/png', buffer: Buffer.from('plain text with a png extension'), message: '图片格式与文件内容不符' },
  { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(7 * 1024 * 1024 + 1), message: '图片不能超过 7 MB' },
]) {
  test(`rejects ${invalid.name} before preview and generation`, async ({ page }) => {
    const posts = await fixture(page)
    await page.locator('input[type=file]').setInputFiles(invalid)
    await expect(page.getByRole('alert')).toContainText(invalid.message)
    await expect(page.getByRole('button', { name: '移除参考图' })).toHaveCount(0)
    expect(posts).toHaveLength(0)
  })
}

test('the same file can be removed and selected again', async ({ page }) => {
  await fixture(page)
  const file = { name: 'same.png', mimeType: 'image/png', buffer: await png(page) }
  const input = page.locator('input[type=file]')
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.setInputFiles(file)
    await expect(page.getByRole('img', { name: 'same.png' })).toBeVisible()
    await page.getByRole('button', { name: '移除参考图' }).click()
    await expect(page.getByRole('img', { name: 'same.png' })).toHaveCount(0)
  }
})

test('a bad replacement clears the old reference and cannot silently send it', async ({ page }) => {
  const posts = await fixture(page)
  const input = page.locator('input[type=file]')
  await input.setInputFiles({ name: 'old.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('img', { name: 'old.png' })).toBeVisible()
  await input.setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('bad') })
  await expect(page.getByRole('alert')).toContainText('图片格式与文件内容不符')
  await expect(page.getByRole('img', { name: 'old.png' })).toHaveCount(0)
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('独立生成')
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0]).not.toHaveProperty('reference')
})

test('selection race keeps the newest image and blocks sending while decoding', async ({ page }) => {
  await fixture(page)
  const buffer = await png(page)
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window)
    window.createImageBitmap = async (...args: Parameters<typeof createImageBitmap>) => {
      const file = args[0] as File
      if (file.name === 'slow.png') await new Promise(resolve => setTimeout(resolve, 800))
      const result = await decode(...args)
      if (file.name === 'slow.png') document.documentElement.dataset.slowDecoded = 'yes'
      return result
    }
  })
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('使用新图')
  const input = page.locator('input[type=file]')
  await input.setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer })
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
  await input.setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer })
  await expect(page.getByRole('img', { name: 'new.png' })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
  await page.waitForFunction(() => !document.querySelector('img[alt="slow.png"]') && document.querySelector('img[alt="new.png"]'))
  await page.waitForFunction(() => document.documentElement.dataset.slowDecoded === 'yes')
  await expect(page.getByRole('img', { name: 'new.png' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'slow.png' })).toHaveCount(0)
})
