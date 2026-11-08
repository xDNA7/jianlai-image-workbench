import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const videoUrl = 'https://media.example/gallery-video.mp4'
const bootstrap = (accountId: string) => ({ accountId, availableCents: 5000, imagePriceCents: 30, capabilities: { sizes: [], qualities: [] } })
const image = { id: 'image-0', jobId: 'image', index: 0, image: '/fixture.png', prompt: '图片作品', created: 200 }
const doneVideo = { id: 'video', status: 'done', prompt: '视频作品示例', created: 300, duration: 10, url: videoUrl }

type Fixture = { account: string; failVideos: boolean; videoCalls: number; videos: unknown[]; refreshed: Record<string, unknown> }
async function fixture(page: Page) {
  const state: Fixture = { account: 'gallery-account', failVideos: false, videoCalls: 0, videos: [doneVideo, { ...doneVideo, id: 'running', status: 'running' }], refreshed: doneVideo }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/videos')) {
      state.videoCalls += 1
      if (state.failVideos) { await route.fulfill({ status: 503, json: { error: '视频列表暂时不可用' } }); return }
      await route.fulfill({ json: { records: state.videos } }); return
    }
    const body = path.endsWith('/bootstrap') ? bootstrap(state.account)
      : path.endsWith('/history') ? { records: [image] }
        : path.endsWith('/videos/video') ? state.refreshed
          : path.endsWith('/chat') ? { used: 0, limit: 50 } : {}
    await route.fulfill({ json: body })
  })
  await page.route('**/fixture.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }))
  return state
}

// Hold metadata requests so the test can inspect native controls without relying
// on an external provider or a browser-specific media decoder fixture.
async function holdMedia(page: Page) {
  let mediaRequests = 0
  let resolve!: () => void
  const released = new Promise<void>(done => { resolve = done })
  await page.route('https://media.example/**', async route => { mediaRequests += 1; await released; await route.abort().catch(() => {}) })
  return { count: () => mediaRequests, release: () => resolve() }
}

test('gallery mixes completed video and images, filters media, and only loads the selected native player', async ({ page }, info) => {
  const state = await fixture(page)
  const media = await holdMedia(page)
  try {
    await page.goto('/')
    await expect(page.getByRole('button', { name: '打开画廊' })).toBeVisible()
    expect(state.videoCalls).toBe(0)
    await page.getByRole('button', { name: '打开画廊' }).click()
    const gallery = page.getByRole('dialog', { name: '画廊面板' })
    await expect(gallery.getByRole('button', { name: '查看视频：视频作品示例' })).toBeVisible()
    await expect(gallery.getByRole('button', { name: /查看视频：/ })).toHaveCount(1)
    await expect(gallery.getByRole('button', { name: /查看视频：|查看作品：/ }).first()).toHaveAccessibleName('查看视频：视频作品示例')
    expect(media.count()).toBe(0)
    await page.screenshot({ path: info.outputPath('mixed-media-gallery.png'), fullPage: true, animations: 'disabled' })
    const filterBounds = await gallery.getByRole('radiogroup', { name: '画廊筛选' }).boundingBox()
    const galleryBounds = await gallery.boundingBox()
    expect(filterBounds && galleryBounds && filterBounds.x + filterBounds.width <= galleryBounds.x + galleryBounds.width + 1).toBeTruthy()
    await gallery.getByRole('radio', { name: '图片', exact: true }).click()
    await expect(gallery.getByRole('button', { name: '查看作品：图片作品' })).toBeVisible()
    await expect(gallery.getByRole('button', { name: /查看视频：/ })).toHaveCount(0)
    await gallery.getByRole('radio', { name: '视频', exact: true }).click()
    await expect(gallery.getByRole('button', { name: /查看作品：/ })).toHaveCount(0)
    await gallery.getByRole('button', { name: '查看视频：视频作品示例' }).click()
    const preview = page.getByRole('dialog', { name: '视频作品预览' })
    const player = preview.locator('video')
    await expect(player).toHaveAttribute('controls', '')
    await expect(player).toHaveAttribute('playsinline', '')
    await expect(player).toHaveAttribute('preload', 'metadata')
    await expect(player).not.toHaveAttribute('autoplay', '')
    await expect(player).toHaveAttribute('src', videoUrl)
    await expect(preview.getByRole('link', { name: '下载视频' })).toHaveAttribute('href', videoUrl)
    await expect(preview.getByRole('button', { name: '收藏', exact: true })).toHaveCount(0)
    await expect.poll(() => preview.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(preview).toBeHidden()
    await expect(page.locator('video')).toHaveCount(0)
  } finally { media.release() }
})

test('unavailable retained video can refresh its link, and a playback error exposes retry', async ({ page }) => {
  const state = await fixture(page)
  state.videos = [{ ...doneVideo, url: null }]
  const media = await holdMedia(page)
  try {
    await page.goto('/')
    await page.getByRole('button', { name: '打开画廊' }).click()
    await page.getByRole('button', { name: '查看视频：视频作品示例' }).click()
    const preview = page.getByRole('dialog', { name: '视频作品预览' })
    await expect(preview.getByText('暂时没有可播放的视频链接', { exact: true })).toBeVisible()
    await expect(preview.getByRole('link', { name: '下载视频' })).toHaveCount(0)
    await preview.getByRole('button', { name: '更新视频链接' }).click()
    await expect(preview.locator('video')).toHaveAttribute('src', videoUrl)
    await preview.locator('video').evaluate(element => element.dispatchEvent(new Event('error')))
    await expect(preview.getByText('视频加载失败', { exact: true })).toBeVisible()
    await preview.getByRole('button', { name: '更新视频链接' }).click()
    await expect(preview.locator('video')).toHaveAttribute('src', videoUrl)
  } finally { media.release() }
})

test('video-list errors retain images and can be retried without reloading the workbench', async ({ page }) => {
  const state = await fixture(page)
  state.failVideos = true
  await page.goto('/')
  await page.getByRole('button', { name: '打开画廊' }).click()
  const gallery = page.getByRole('dialog', { name: '画廊面板' })
  await expect(gallery.getByText('视频作品加载失败')).toBeVisible()
  await expect(gallery.getByRole('button', { name: '查看作品：图片作品' })).toBeVisible()
  state.failVideos = false
  await gallery.getByRole('button', { name: '重试视频作品' }).click()
  await expect(gallery.getByRole('button', { name: '查看视频：视频作品示例' })).toBeVisible()
  await expect(gallery.getByText('视频作品加载失败')).toHaveCount(0)
})

test('an account refresh removes the previous video preview and its cached gallery immediately', async ({ page }) => {
  await page.clock.install()
  const state = await fixture(page)
  state.videos = [{ ...doneVideo, url: null }]
  await page.goto('/')
  await page.getByRole('button', { name: '打开画廊' }).click()
  await page.getByRole('button', { name: '查看视频：视频作品示例' }).click()
  await expect(page.getByRole('dialog', { name: '视频作品预览' })).toBeVisible()
  state.account = 'next-gallery-account'
  state.videos = []
  await page.clock.setFixedTime(new Date(Date.now() + 31_000))
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')) })
  await expect(page.getByRole('dialog', { name: '视频作品预览' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看视频：视频作品示例' })).toHaveCount(0)
})
