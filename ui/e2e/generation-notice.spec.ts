import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const NOTICE = '如果上下文干扰，请清空对话。'
const OSS = 'https://public-assets.example/assets/jianlai/'
const JOB = 'd'.repeat(32)
const PHOTO = readFileSync(new URL('../src/design/orange-example.webp', import.meta.url))
const SOURCE = { title: '人物样本一', imageUrl: `${OSS}reference/a.webp`, thumbUrl: `${OSS}reference/a.webp`, sourceUrl: 'https://commons.wikimedia.org/wiki/File:Sample-a.webp', artist: '摄影师甲', license: 'CC BY 4.0' }
const SOURCES = [SOURCE, { ...SOURCE, title: '人物样本二', imageUrl: `${OSS}reference/b.webp`, sourceUrl: 'https://commons.wikimedia.org/wiki/File:Sample-b.webp', artist: '摄影师乙' }]

async function install(page: Page, delivered: number, failed = false) {
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(`${OSS}**`, route => route.fulfill({ status: 200, contentType: 'image/webp', body: PHOTO }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/bootstrap')) return json(route, {
      accountId: 'generation-notice', availableCents: 5000, imagePriceCents: 30, activeJob: null, activeVideo: null,
      capabilities: { sizes: [{ value: 'auto', label: '自动画幅' }], qualities: [{ value: 'medium', label: '精细' }] },
    })
    if (path.endsWith('/templates')) return json(route, { templates: [] })
    if (path.endsWith('/history') || path.endsWith('/videos')) return json(route, { records: [] })
    if (path.endsWith('/chat') && route.request().method() === 'GET') return json(route, { used: 0, limit: 50 })
    if (path.endsWith('/chat')) {
      const events: [string, unknown][] = [
        ['delta', { text: '已补充光源方向和主体留白。' }],
        ['plan', { prompt: '人物摄影', text: '', size: 'auto', quality: 'medium', count: 2, useReference: false }],
        ['done', {}],
      ]
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') })
    }
    if (path.endsWith('/generate')) return json(route, { id: JOB, status: 'running', phase: 'queued' }, 202)
    if (path.includes('/jobs/')) return json(route, {
      id: JOB, status: failed ? 'failed' : 'done', phase: failed ? 'failed' : 'done', charged: delivered * .3,
      ...(delivered < 2 ? { error: '上游未交付其余图片' } : {}),
      images: Array.from({ length: delivered }, (_, index) => ({ index, url: `${OSS}notice/original-${index}.webp`, previewUrl: `${OSS}notice/preview-${index}.webp`, downloadUrl: `${OSS}notice/original-${index}.webp` })),
    })
    return json(route, { error: `Unexpected mocked API request: ${path}` }, 501)
  })
}

for (const scenario of [{ name: 'two delivered images', delivered: 2 }, { name: 'partial success', delivered: 1 }, { name: 'failed generation', delivered: 0, failed: true }]) {
  test(`${scenario.name}: context notice appears once per delivered image`, async ({ page }) => {
    await install(page, scenario.delivered, scenario.failed)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('生成两张人物摄影图')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const plan = page.getByRole('region', { name: '生成方案' })
    await expect(plan).toBeVisible()
    await expect(page.getByText(NOTICE, { exact: true })).toHaveCount(0)
    await plan.getByRole('button', { name: '生成', exact: true }).click()
    if (scenario.failed) {
      await expect(page.getByText('上游未交付其余图片', { exact: true })).toBeVisible()
    } else {
      await expect(page.getByText(`已完成 · ${scenario.delivered} 张`, { exact: false })).toBeVisible()
    }
    await expect(page.locator('.job-card figure')).toHaveCount(scenario.delivered)
    await expect(page.getByText(NOTICE, { exact: true })).toHaveCount(scenario.delivered)
    for (const figure of await page.locator('.job-card figure').all()) {
      await figure.scrollIntoViewIfNeeded()
      await expect(figure.locator('figcaption')).toHaveText(NOTICE)
      await expect(figure.getByText(NOTICE, { exact: true })).toBeVisible()
      await expect(figure.getByRole('button', { name: '修改这张图' })).toHaveCount(1)
      await expect(figure.getByRole('link', { name: '下载原图' })).toHaveCount(1)
    }
  })
}

test('restored delivered images show all reference credits without legacy duplicates', async ({ page }) => {
  await install(page, 1)
  await page.addInitScript(({ job, sources, source, oss }) => {
    localStorage.setItem('jianlai-chat:v1:generation-notice', JSON.stringify([{
      type: 'job', id: 'restored-card', jobId: job, requestKey: 'restored-key', status: 'done', phase: 'done',
      plan: { prompt: '人物摄影', text: '', size: 'auto', quality: 'medium', count: 1, useReference: false, publicFigureSources: sources, publicFigureSource: source },
      reference: { kind: 'picked', url: source.imageUrl, preview: source.thumbUrl, prompt: '人物参考', source },
      images: [{ id: `${job}-0`, jobId: job, index: 0, preview: `${oss}notice/preview-0.webp`, download: `${oss}notice/original-0.webp`, prompt: '人物摄影' }],
      chargedCents: 30, started: 1, created: 1,
    }]))
  }, { job: JOB, sources: SOURCES, source: SOURCE, oss: OSS })
  await page.goto('/', { waitUntil: 'networkidle' })
  const sources = page.getByText('人物参考来源 · 2 张', { exact: true })
  await expect(sources).toBeVisible()
  await sources.click()
  await expect(page.getByRole('link', { name: '人物样本一' })).toHaveCount(1)
  await expect(page.getByRole('link', { name: '人物样本二' })).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Sample-b.webp')
  await expect(page.getByText('摄影师乙 · CC BY 4.0', { exact: false })).toBeVisible()
  await expect(page.getByText(NOTICE, { exact: true })).toBeVisible()
})
