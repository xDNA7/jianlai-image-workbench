import { deflateSync } from 'node:zlib'
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { PublicFigureSource } from '../src/chat/types'
import type { Page, Route } from '@playwright/test'

const OSS = 'https://public-assets.example/assets/jianlai/'
const JOB = 'b'.repeat(32)
const crc32 = (bytes: Buffer) => {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
const chunk = (name: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(name), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
// Distinct, decodable images prove that actual pixels reach the generation API.
const png = (seed: number) => {
  const width = 240
  const height = 320
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc(height * (width * 3 + 1))
  let random = seed + 1
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width * 3; x++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      pixels[y * (width * 3 + 1) + x] = random >>> 24
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ])
}
const images = Array.from({ length: 5 }, (_, index) => png(index))
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
const sources = Array.from({ length: 4 }, (_, index) => ({
  title: `File:Jay Chou portrait ${index + 1}.png`,
  thumbUrl: `https://upload.wikimedia.org/jay-${index + 1}-thumb.png`,
  imageUrl: `https://upload.wikimedia.org/jay-${index + 1}.png`,
  sourceUrl: `https://commons.wikimedia.org/wiki/File:Jay_Chou_portrait_${index + 1}.png`,
  artist: `Photographer ${index + 1}`, license: 'CC BY-SA 4.0', entityId: 'Q16523', personName: '周杰伦',
}))
type Generate = { mode: string; count: number; prompt: string; references: string[]; requestKey: string }
type Mock = {
  visualIntent?: boolean
  generates: Generate[]; searches: string[]; downloads: string[]
  result: { name: string; entityId: string; sources: PublicFigureSource[] }
  planFigures?: string[] | string; context?: string; searchContexts: string[]; results?: Record<string, Mock['result']>
  searchStatus: number; holdSearch?: Promise<void>; holdDownloads?: Promise<void>
  brokenImage?: string; rejectFirstGenerate: boolean; loseFirstGenerateResponse: boolean
  acceptedJobs: Map<string, string>
}
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const sse = (events: [string, unknown][]) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

async function install(page: Page): Promise<Mock> {
  const mock: Mock = {
    generates: [], searches: [], searchContexts: [], downloads: [], searchStatus: 200, rejectFirstGenerate: false,
    loseFirstGenerateResponse: false, acceptedJobs: new Map(),
    result: { name: '周杰伦', entityId: 'Q16523', sources: structuredClone(sources) },
  }
  await page.route('https://upload.wikimedia.org/**', route => route.fulfill({ contentType: 'image/png', body: images[0] }))
  await page.route('https://www.sinaimg.cn/**', route => route.fulfill({ contentType: 'image/png', body: images[0] }))
  await page.route(`${OSS}**`, route => route.fulfill({ contentType: 'image/png', body: images[0] }))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.endsWith('/bootstrap')) return json(route, {
      accountId: 'public-figure-test', availableCents: 5000, imagePriceCents: 30, activeJob: null, activeVideo: null,
      capabilities: {
        sizes: [{ value: 'auto', label: '自动画幅' }, { value: '1536x1024', label: '横版' }],
        qualities: [{ value: 'medium', label: '精细' }],
      },
    })
    if (path.endsWith('/history') || path.endsWith('/videos')) return json(route, { records: [] })
    if (path.endsWith('/templates')) return json(route, { templates: [] })
    if (path.endsWith('/public-figure-search')) {
      mock.searches.push(url.searchParams.get('name') || '')
      mock.searchContexts.push(url.searchParams.get('context') || '')
      const result = structuredClone(mock.results?.[url.searchParams.get('name') || ''] ?? mock.result)
      const status = mock.searchStatus
      if (mock.holdSearch) await mock.holdSearch
      return json(route, status === 200 ? result : { error: '人物检索服务暂时不可用' }, status)
    }
    if (path.endsWith('/public-image')) {
      const source = url.searchParams.get('url') || ''
      mock.downloads.push(source)
      if (mock.holdDownloads) await mock.holdDownloads
      if (source === mock.brokenImage) return route.fulfill({ contentType: 'image/png', body: Buffer.from('not an image') })
      const samples = mock.results ? Object.values(mock.results).flatMap(result => result.sources) : sources
      const index = samples.findIndex(item => item.imageUrl === source)
      if (index < 0) return json(route, { error: '未知来源' }, 400)
      return route.fulfill({ contentType: 'image/png', body: images[index] })
    }
    if (path.endsWith('/chat') && request.method() === 'GET') return json(route, { used: 0, limit: 50 })
    if (path.endsWith('/chat')) return route.fulfill({
      contentType: 'text/event-stream', body: sse([
        ['meta', { used: 1, limit: 50 }], ['delta', { text: '我整理成下面的方案：' }],
        ['plan', { prompt: mock.visualIntent === false ? '演唱会海报，标题写周杰伦巡演' : '周杰伦在雨后江南街头，穿蓝色外套', text: mock.visualIntent === false ? '周杰伦巡演' : '', size: 'auto', quality: 'medium', count: 1, useReference: Boolean(request.postDataJSON().reference), publicFigureVisual: mock.visualIntent !== false, ...(Array.isArray(mock.planFigures) ? { publicFigures: mock.planFigures } : { publicFigure: mock.planFigures ?? '周杰伦' }), publicFigureContext: mock.context }],
        ['done', {}],
      ]),
    })
    if (path.endsWith('/generate')) {
      mock.generates.push(request.postDataJSON())
      if (mock.rejectFirstGenerate && mock.generates.length === 1) return json(route, { error: '请求内容过大' }, 413)
      const key = mock.generates.at(-1)!.requestKey
      if (!mock.acceptedJobs.has(key)) mock.acceptedJobs.set(key, JOB)
      if (mock.loseFirstGenerateResponse && mock.generates.length === 1) return route.abort('failed')
      return json(route, { id: mock.acceptedJobs.get(key), status: 'running', phase: 'queued' }, 202)
    }
    if (path.includes('/jobs/')) return json(route, {
      id: JOB, status: 'done', phase: 'done', charged: 0.3, availableCents: 4970,
      images: [{ index: 0, url: `${OSS}j/original.png`, previewUrl: `${OSS}j/preview.png`, downloadUrl: `${OSS}j/original.png` }],
    })
    return json(route, {})
  })
  return mock
}
const send = async (page: Page, text = '周杰伦在雨后江南街头，穿蓝色外套') => {
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
const card = (page: Page) => page.getByRole('region', { name: '生成方案' })
const confirm = (page: Page) => card(page).getByRole('button', { name: /^(生成|确认生成)$/ })
const ready = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page)
  await expect(confirm(page)).toBeEnabled()
  await card(page).getByText('核对人物与图片来源', { exact: true }).click()
}

test('a person name used only as poster text does not block generation with image search', async ({ page }) => {
  const mock = await install(page)
  mock.visualIntent = false
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page)
  await expect(confirm(page)).toBeEnabled()
  await expect(card(page).getByRole('region', { name: '人物参考图' })).toHaveCount(0)
  expect(mock.searches).toHaveLength(0)
  await confirm(page).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0].text).toBe('周杰伦巡演')
})

test('a failed public search can continue with a user uploaded reference image', async ({ page }) => {
  const mock = await install(page)
  mock.searchStatus = 502
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page)
  await expect(card(page).getByRole('alert')).toBeVisible()
  await page.getByLabel('上传人物参考图').setInputFiles({ name: 'person.png', mimeType: 'image/png', buffer: images[0] })
  await expect(confirm(page)).toBeEnabled()
  await confirm(page).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0].references).toHaveLength(1)
})

for (const count of [2, 3]) {
  test(`automatically finds one person and submits ${count} distinct image bytes only after confirmation`, async ({ page }, info) => {
    const mock = await install(page)
    let release!: () => void
    mock.holdSearch = new Promise<void>(resolve => { release = resolve })
    if (count === 2) mock.result.sources = mock.result.sources.slice(0, 2)
    await page.goto('/', { waitUntil: 'networkidle' })
    await send(page)
    await expect.poll(() => mock.searches.length).toBe(1)
    await expect(card(page).getByRole('status')).toBeVisible()
    await expect(confirm(page)).toBeDisabled()
    expect(mock.generates).toHaveLength(0)
    expect(mock.downloads).toHaveLength(0)
    release()
    await expect(confirm(page)).toBeEnabled()
    await expect(card(page).getByRole('region', { name: '人物参考图' })).toBeVisible()
    await card(page).getByText('核对人物与图片来源', { exact: true }).click()
    await expect(card(page).getByRole('checkbox', { checked: true })).toHaveCount(count)
    expect(mock.searches).toEqual(['周杰伦'])
    expect(mock.generates).toHaveLength(0)
    expect(mock.downloads).toHaveLength(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await mkdir('/tmp/jianlai-intent-figures-20261107', { recursive: true })
    await page.screenshot({ path: `/tmp/jianlai-intent-figures-20261107/${info.project.name}-${count}-references.png` })
    await confirm(page).click()
    await expect.poll(() => mock.generates.length).toBe(1)
    const generated = mock.generates[0]
    expect(generated.mode).toBe('blend')
    expect(generated.count).toBe(1)
    expect(generated.references).toEqual(images.slice(0, count).map(dataUrl))
    expect(generated.prompt).toContain('人物身份参考')
    expect(generated.prompt).toMatch(/不要复制|不复制|不照搬/)
    expect(generated.prompt).toContain('蓝色外套')
    expect(mock.downloads).toEqual(sources.slice(0, count).map(source => source.imageUrl))
    await page.getByText(`人物参考来源 · ${count} 张`, { exact: true }).click()
    for (const source of sources.slice(0, count)) {
      await expect(page.getByRole('link', { name: source.title, exact: true })).toHaveAttribute('href', source.sourceUrl)
      await expect(page.getByText(source.artist, { exact: false })).toBeVisible()
    }
  })
}

test('deselecting down to one identity photo blocks confirmation', async ({ page }) => {
  const mock = await install(page)
  await ready(page)
  const checked = card(page).getByRole('checkbox', { checked: true })
  await checked.last().uncheck()
  await expect(confirm(page)).toBeEnabled()
  await checked.last().uncheck()
  await expect(confirm(page)).toBeDisabled()
  expect(mock.generates).toHaveLength(0)
  expect(mock.downloads).toHaveLength(0)
  await card(page).getByRole('checkbox', { checked: false }).first().check()
  await expect(confirm(page)).toBeEnabled()
})

for (const failure of ['unavailable', 'insufficient', 'mixed-person', 'duplicate'] as const) {
  test(`offers a no-reference fallback when the public image result is unsafe: ${failure}`, async ({ page }) => {
    const mock = await install(page)
    if (failure === 'unavailable') mock.searchStatus = 502
    if (failure === 'insufficient') mock.result.sources = mock.result.sources.slice(0, 1)
    if (failure === 'mixed-person') mock.result.sources = mock.result.sources.slice(0, 2).map((source, index) => ({ ...source, entityId: index ? 'Q42' : source.entityId }))
    if (failure === 'duplicate') mock.result.sources = [mock.result.sources[0], { ...mock.result.sources[0] }]
    await page.goto('/', { waitUntil: 'networkidle' })
    await send(page)
    await expect(card(page).getByRole('alert')).toBeVisible()
    await expect(confirm(page)).toBeDisabled()
    expect(mock.generates).toHaveLength(0)
    expect(mock.downloads).toHaveLength(0)
    await card(page).getByRole('button', { name: '去掉人物参考，继续生成' }).click()
    await expect(confirm(page)).toBeEnabled()
    await confirm(page).click()
    await expect.poll(() => mock.generates.length).toBe(1)
    expect(mock.generates[0].references).toHaveLength(0)
  })
}

test('a corrupt identity image prevents every generation request and remains retryable', async ({ page }) => {
  const mock = await install(page)
  mock.brokenImage = sources[1].imageUrl
  await ready(page)
  await confirm(page).click()
  const failure = page.getByRole('alert').filter({ hasText: '未提交' })
  await expect(failure).toContainText('未扣费')
  expect(mock.generates).toHaveLength(0)
  mock.brokenImage = undefined
  await failure.getByRole('button', { name: /重试|重新|继续提交/ }).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0].references).toHaveLength(3)
  expect(new Set(mock.generates[0].references).size).toBe(3)
  expect(mock.generates[0].references[0]).not.toBe(mock.generates[0].references[1])
})

test('keeps the uploaded base image first and appends three identity photos', async ({ page }) => {
  const mock = await install(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').first().setInputFiles({ name: 'base.png', mimeType: 'image/png', buffer: images[4] })
  await send(page)
  await expect(confirm(page)).toBeEnabled()
  await card(page).getByText('核对人物与图片来源', { exact: true }).click()
  await expect(card(page).getByRole('checkbox', { checked: true })).toHaveCount(3)
  await confirm(page).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0].mode).toBe('edit')
  expect(mock.generates[0].references).toEqual([dataUrl(images[4]), ...images.slice(0, 3).map(dataUrl)])
})

test('a confirmed 413 compresses every identity image and changes the retry key once', async ({ page }) => {
  const mock = await install(page)
  mock.rejectFirstGenerate = true
  await ready(page)
  await confirm(page).click()
  await expect.poll(() => mock.generates.length, { timeout: 15_000 }).toBe(2)
  const [original, retry] = mock.generates
  expect(original.requestKey).not.toBe(retry.requestKey)
  expect(original.references).toHaveLength(3)
  expect(retry.references).toHaveLength(3)
  for (const [index, reference] of retry.references.entries()) {
    expect(reference).toMatch(/^data:image\/(webp|jpeg|png);base64,/)
    expect(reference.length).toBeLessThan(original.references[index].length)
  }
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(mock.generates).toHaveLength(2)
})

test('clearing a thread ignores a late identity search and keeps the next context clean', async ({ page }) => {
  const mock = await install(page)
  let release!: () => void
  mock.holdSearch = new Promise<void>(resolve => { release = resolve })
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page)
  await expect.poll(() => mock.searches.length).toBe(1)
  const menu = page.getByRole('button', { name: '打开菜单' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: '清空对话', exact: true }).click()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  release()
  mock.holdSearch = undefined
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  expect(mock.generates).toHaveLength(0)
  await send(page, '重新画周杰伦，背景换成纯白')
  await expect(confirm(page)).toBeEnabled()
  expect(mock.searches).toHaveLength(2)
  await card(page).getByText('核对人物与图片来源', { exact: true }).click()
  await expect(card(page).getByRole('checkbox', { checked: true })).toHaveCount(3)
  expect(mock.generates).toHaveLength(0)
})

test('an accepted request with a lost response stays unknown when retry image loading fails and keeps its original key', async ({ page }) => {
  const mock = await install(page)
  // Exercise the not-yet-discoverable branch: only a lookup 404 permits preparing
  // references and replaying the same key; acceptedJobs still deduplicates it.
  await page.route('**/api/jobs/by-request?**', route => json(route, { error: '任务暂未查到' }, 404))
  mock.loseFirstGenerateResponse = true
  await ready(page)
  await confirm(page).click()
  const retry = page.getByRole('button', { name: '按原请求继续提交', exact: true })
  await expect(retry).toBeVisible()
  expect(mock.generates).toHaveLength(1)
  expect(mock.acceptedJobs.size).toBe(1)
  const originalKey = mock.generates[0].requestKey
  mock.brokenImage = sources[1].imageUrl
  await retry.click()
  await expect(retry).toBeVisible()
  const failure = page.getByRole('alert').filter({ has: retry })
  await expect(failure).not.toContainText('未扣费')
  await expect(failure).not.toContainText('未提交')
  await expect(failure).toContainText('最终状态和费用待确认')
  await expect.poll(async () => page.evaluate(() => {
    const records = JSON.parse(localStorage.getItem('jianlai-chat:v1:public-figure-test') || '[]')
    return records.filter((item: { type: string }) => item.type === 'job').map((item: { status: string; requestKey: string }) => ({ status: item.status, requestKey: item.requestKey }))
  })).toEqual([{ status: 'unknown', requestKey: originalKey }])
  expect(mock.generates).toHaveLength(1)
  mock.brokenImage = undefined
  await retry.click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(mock.generates.map(item => item.requestKey)).toEqual([originalKey, originalKey])
  expect(mock.acceptedJobs.size).toBe(1)
})

test('clearing while identity downloads are pending prevents a late generation submission', async ({ page }) => {
  const mock = await install(page)
  await ready(page)
  let release!: () => void
  mock.holdDownloads = new Promise<void>(resolve => { release = resolve })
  await confirm(page).click()
  await expect.poll(() => mock.downloads.length).toBe(3)
  expect(mock.generates).toHaveLength(0)
  const menu = page.getByRole('button', { name: '打开菜单' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: '清空对话', exact: true }).click()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  release()
  mock.holdDownloads = undefined
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: '把想法，变成画面。' })).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停止等待' })).toHaveCount(0)
  expect(mock.generates).toHaveLength(0)
  expect(mock.acceptedJobs.size).toBe(0)
})


const configurePair = (mock: Mock, legacy = false) => {
  mock.planFigures = legacy ? '厉娜、许飞' : ['厉娜', '许飞']
  mock.context = '超级女声 歌手'
  mock.results = Object.fromEntries(['厉娜', '许飞'].map((name, person) => [name, {
    name, entityId: person ? 'Q6701420' : 'Q8992471', sources: sources.slice(person * 2, person * 2 + 2).map(source => ({ ...source, personName: name, entityId: person ? 'Q6701420' : 'Q8992471' })),
  }]))
}

for (const legacy of [false, true]) {
  test(`two singers are independently searched and submitted together with numbered identities (${legacy ? 'legacy' : 'array'})`, async ({ page }) => {
    const mock = await install(page)
    configurePair(mock, legacy)
    await page.goto('/', { waitUntil: 'networkidle' })
    await send(page, '厉娜、许飞合照，超级女声歌手')
    await expect(confirm(page)).toBeEnabled()
    expect(mock.searches.slice().sort()).toEqual(['厉娜', '许飞'].sort())
    expect(mock.searchContexts).toEqual(['超级女声 歌手', '超级女声 歌手'])
    expect(mock.generates).toHaveLength(0)
    expect(mock.downloads).toHaveLength(0)
    await confirm(page).click()
    await expect.poll(() => mock.generates.length).toBe(1)
    expect(mock.generates[0].references).toEqual(images.slice(0, 4).map(dataUrl))
    expect(mock.generates[0].prompt).toContain('第1张、第2张为厉娜')
    expect(mock.generates[0].prompt).toContain('第3张、第4张为许飞')
    expect(mock.generates[0].prompt).not.toContain('同一位')
    expect(new Set(mock.generates[0].references).size).toBe(4)
  })
}

test('a missing second person blocks generation and retries only that person', async ({ page }) => {
  const mock = await install(page)
  configurePair(mock)
  mock.results!['许飞'].sources = mock.results!['许飞'].sources.slice(0, 1)
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '厉娜、许飞合照')
  await expect(card(page).getByRole('alert').filter({ hasText: '许飞' })).toBeVisible()
  await expect(confirm(page)).toBeDisabled()
  expect(mock.generates).toHaveLength(0)
  expect(mock.downloads).toHaveLength(0)
  const firstCalls = mock.searches.filter(name => name === '厉娜').length
  configurePair(mock)
  await card(page).getByRole('button', { name: '重新搜索许飞人物图片' }).click()
  await expect(confirm(page)).toBeEnabled()
  expect(mock.searches.filter(name => name === '厉娜')).toHaveLength(firstCalls)
  expect(mock.generates).toHaveLength(0)
})

test('an uploaded base plus two people clearly blocks the four-image capacity until adjusted', async ({ page }) => {
  const mock = await install(page)
  configurePair(mock)
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').first().setInputFiles({ name: 'base.png', mimeType: 'image/png', buffer: images[4] })
  await send(page, '厉娜、许飞合照')
  await expect(card(page).getByRole('alert').filter({ hasText: '最多使用 4 张参考图' })).toBeVisible()
  await expect(confirm(page)).toBeDisabled()
  expect(mock.generates).toHaveLength(0)
  expect(mock.downloads).toHaveLength(0)
  await card(page).getByRole('button', { name: '不用参考图', exact: true }).click()
  await expect(confirm(page)).toBeEnabled()
  await confirm(page).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.generates[0].references).toEqual(images.slice(0, 4).map(dataUrl))
})


test('two domestic gallery sources per person use the public image proxy and retain all four bytes', async ({ page }, info) => {
  const mock = await install(page)
  configurePair(mock)
  for (const [name, result] of Object.entries(mock.results!)) result.sources = result.sources.map((source, index) => ({
    ...source, provider: 'Sogou/Sina', title: `${name}演唱照片${index + 1}`, artist: '新浪娱乐', license: '来源页未标注许可，仅作人物参考',
    imageUrl: `https://www.sinaimg.cn/${result.entityId}-${index}.png`, thumbUrl: `https://www.sinaimg.cn/${result.entityId}-${index}-thumb.png`, sourceUrl: `https://slide.ent.sina.com.cn/${result.entityId}.html?gallery=1`,
  }))
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '厉娜、许飞合照')
  await expect(confirm(page)).toBeEnabled()
  await expect(card(page).getByText('国内来源页未标注许可，仅作人物身份参考；请核对原始报道与人物。')).toHaveCount(2)
  for (const summary of await card(page).getByText('核对人物与图片来源', { exact: true }).all()) await summary.click()
  await expect(card(page).getByRole('checkbox', { checked: true })).toHaveCount(4)
  await page.screenshot({ path: `/tmp/jianlai-china-figures-20261107/pair-plan-${info.project.name}.png`, fullPage: true })
  await confirm(page).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  await page.screenshot({ path: `/tmp/jianlai-china-figures-20261107/pair-result-${info.project.name}.png`, fullPage: true })
  expect(mock.generates[0].references).toEqual(images.slice(0, 4).map(dataUrl))
  expect(mock.downloads).toHaveLength(4)
  expect(mock.downloads.every(url => url.startsWith('https://www.sinaimg.cn/'))).toBe(true)
})

function configureDomesticPair(mock: Mock) {
  configurePair(mock)
  for (const [name, result] of Object.entries(mock.results!)) result.sources = result.sources.map((source, index) => ({
    ...source, provider: 'Sogou/Sina', title: `${name}演唱照片${index + 1}`, artist: '新浪娱乐', license: '来源页未标注许可，仅作人物参考',
    imageUrl: `https://www.sinaimg.cn/${result.entityId}-${index}.png`, thumbUrl: `https://www.sinaimg.cn/${result.entityId}-${index}-thumb.png`, sourceUrl: `https://slide.ent.sina.com.cn/${result.entityId}.html?gallery=1`,
  }))
}

test('an unknown domestic request recovers by its original key without expired image downloads or another submission', async ({ page }) => {
  const mock = await install(page)
  configureDomesticPair(mock)
  mock.loseFirstGenerateResponse = true
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '超级女声厉娜、许飞合照')
  await expect(confirm(page)).toBeEnabled()
  await confirm(page).click()
  const retry = page.getByRole('button', { name: '按原请求继续提交', exact: true })
  await expect(retry).toBeVisible()
  const originalKey = mock.generates[0].requestKey
  const oldDownloads = mock.downloads.length
  let lookedUp = ''
  await page.route('**/api/jobs/by-request?**', route => {
    lookedUp = new URL(route.request().url()).searchParams.get('requestKey') || ''
    return json(route, { id: JOB, status: 'done', charged: .3, images: [{ index: 0, url: `${OSS}j/original.png`, previewUrl: `${OSS}j/preview.png`, downloadUrl: `${OSS}j/original.png` }] })
  })
  mock.brokenImage = mock.results!['厉娜'].sources[0].imageUrl
  await retry.click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(lookedUp).toBe(originalKey)
  expect(mock.generates).toHaveLength(1)
  expect(mock.downloads).toHaveLength(oldDownloads)
})

test('retrying domestic photos revalidates original exact sources before downloading and preserves four references', async ({ page }) => {
  const mock = await install(page)
  configureDomesticPair(mock)
  mock.brokenImage = mock.results!['厉娜'].sources[0].imageUrl
  await page.goto('/', { waitUntil: 'networkidle' })
  await send(page, '超级女声厉娜、许飞合照')
  await expect(confirm(page)).toBeEnabled()
  await confirm(page).click()
  const failure = page.getByRole('alert').filter({ hasText: '未提交' })
  await expect(failure).toContainText('未扣费')
  expect(mock.generates).toHaveLength(0)
  const oldSearches = mock.searches.length
  mock.brokenImage = undefined
  await failure.getByRole('button', { name: /重试|重新|继续提交/ }).click()
  await expect.poll(() => mock.generates.length).toBe(1)
  expect(mock.searches.length).toBe(oldSearches + 2)
  expect(mock.generates[0].references).toEqual(images.slice(0, 4).map(dataUrl))
})
