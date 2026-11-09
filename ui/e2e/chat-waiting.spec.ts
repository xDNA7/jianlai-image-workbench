import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

async function install(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window)
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    window.addEventListener('chat-test-event', ((event: CustomEvent<{ event: string; data: unknown }>) => {
      if (!stream) return
      const { event: name, data } = event.detail
      stream.enqueue(new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
      if (name === 'done' || name === 'error') {
        stream.close()
        stream = undefined
      }
    }) as EventListener)
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin)
      if (url.pathname.endsWith('/api/chat') && init?.method === 'POST') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            init.signal?.addEventListener('abort', () => {
              stream?.error(new DOMException('Aborted', 'AbortError'))
              stream = undefined
            }, { once: true })
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return nativeFetch(input, init)
    }
  })
  const json = (route: Route, body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/bootstrap')) return json(route, {
      accountId: 'chat-waiting', availableCents: 5000, imagePriceCents: 30, activeJob: null,
      capabilities: { sizes: [{ value: 'auto', label: '自动画幅' }], qualities: [{ value: 'medium', label: '精细' }] },
    })
    if (path.endsWith('/video-access')) return json(route, { authenticated: false })
    if (path.endsWith('/history') || path.endsWith('/videos')) return json(route, { records: [] })
    if (path.endsWith('/chat')) return json(route, { used: 0, limit: 50 })
    if (path.endsWith('/templates')) return json(route, { templates: [] })
    return route.fulfill({ status: 501, json: { error: 'Unexpected mocked request' } })
  })
}

async function event(page: Page, name: string, data: unknown = {}) {
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('chat-test-event', { detail })), { event: name, data })
}

async function start(page: Page) {
  await install(page)
  await page.goto('/')
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('帮我做一张咖啡馆海报')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '正在理解需求' })).toBeVisible()
  await expect(page.getByRole('region', { name: '生成方案' })).toHaveCount(0)
}

test('waiting continues after reply text and ends as soon as the generation plan arrives', async ({ page }, info) => {
  await start(page)
  await event(page, 'delta', { text: '已理解你的需求，接下来整理生成方案。' })
  const waiting = page.getByRole('status').filter({ hasText: '正在整理生成方案' })
  await expect(waiting).toBeVisible()
  await expect(page.getByText('已理解你的需求，接下来整理生成方案。', { exact: true })).toBeVisible()
  await expect(waiting.locator('.chat-dots > span')).toHaveCount(3)
  await expect(waiting.locator('.chat-dots > span').first()).not.toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: `test-results/shots/${info.project.name}-chat-waiting.png` })
  await event(page, 'plan', { prompt: '温暖的咖啡馆海报', text: '', size: 'auto', quality: 'medium', count: 1, useReference: false })
  await expect(page.locator('.jl-chat-waiting')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '生成方案' })).toBeVisible()
  await event(page, 'done')
  await expect(page.getByRole('button', { name: '停止回复' })).toHaveCount(0)
})

for (const terminal of ['done', 'error', 'stop'] as const) {
  test(`waiting ends when the reply reaches ${terminal} without a plan`, async ({ page }) => {
    await start(page)
    await event(page, 'delta', { text: '已理解你的需求。' })
    await expect(page.getByRole('status').filter({ hasText: '正在整理生成方案' })).toBeVisible()
    if (terminal === 'stop') await page.getByRole('button', { name: '停止回复' }).click()
    else await event(page, terminal, terminal === 'error' ? { error: '方案服务暂时不可用' } : {})
    await expect(page.getByRole('button', { name: '停止回复' })).toHaveCount(0)
    await expect(page.locator('.jl-chat-waiting')).toHaveCount(0)
    if (terminal === 'error') await expect(page.getByRole('alert')).toHaveText('方案服务暂时不可用')
  })
}

test('reduced motion keeps a readable waiting status without continuous animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await start(page)
  await event(page, 'delta', { text: '已理解你的需求。' })
  const waiting = page.getByRole('status').filter({ hasText: '正在整理生成方案' })
  await expect(waiting).toBeVisible()
  await expect(waiting.locator('.chat-dots > span').first()).toHaveCSS('animation-name', 'none')
  await event(page, 'done')
  await expect(waiting).toHaveCount(0)
})
