import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

const adminPath = 'admin-fixture-abcdefghijklmnop'
const visitor = '0'.repeat(32)
const firstUser = '1'.repeat(32)
const secondUser = '2'.repeat(32)
const firstJob = 'a'.repeat(32)
const secondJob = 'b'.repeat(32)
const imageBytes = readFileSync(new URL('../src/assets/account-avatar.webp', import.meta.url))
const now = Date.UTC(2026, 10, 7, 10)
const directory = [
  { id: visitor, imageCount: 0, lastCreated: null },
  { id: firstUser, imageCount: 1, lastCreated: now },
  { id: secondUser, imageCount: 1, lastCreated: now - 1000 },
]
const artwork = (jobId: string, url: string | null = null) => ({
  id: `${jobId}:0`, jobId, index: 0, url, downloadUrl: null,
  created: now, expiresAt: now + 30 * 86400_000,
  prompt: '确定性的管理员作品 fixture', text: '', hiddenUser: false,
})

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function fixture(page: Page, authenticated = true, users = directory) {
  const state = {
    authenticated,
    users,
    directoryError: '',
    directoryGate: null as ReturnType<typeof gate> | null,
    imagesError: '',
    imageGates: new Map<string, ReturnType<typeof gate>>(),
    images: new Map([[firstUser, [artwork(firstJob)]], [secondUser, [artwork(secondJob)]]]),
    mutations: [] as string[],
    requests: [] as string[],
    loginBody: null as unknown,
    protectedImages: [] as string[],
    ossRequests: [] as string[],
  }
  await page.route('https://admin-oss.invalid/**', route => {
    state.ossRequests.push(route.request().url())
    return route.fulfill({ status: 403, body: 'expired signature fixture' })
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    state.requests.push(path)
    const endpoint = path.split(`/api/admin/${adminPath}/`)[1]
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (request.method() !== 'GET') state.mutations.push(`${request.method()} ${endpoint}`)
    if (endpoint === 'session') return json(state.authenticated ? {
      authenticated: true, username: 'fixture-admin', csrf: 'fixture-csrf',
      balance: 100, available: 100, reserved: 0,
      stats: { templateCount: 1, userCount: 3, imageCount: 2, runningCount: 0 },
    } : { authenticated: false })
    if (endpoint === 'login' && request.method() === 'POST') {
      state.loginBody = request.postDataJSON()
      state.authenticated = true
      return json({ authenticated: true, username: 'fixture-admin', csrf: 'fixture-csrf', balance: 100 })
    }
    if (endpoint === 'templates') return json({ templates: [{ id: 'fixture-template', title: '橙子海报', category: 'poster', tags: ['橙色'], prompt: '橙子' }] })
    if (endpoint === 'users') {
      const pending = state.directoryGate
      const error = state.directoryError
      const users = state.users
      if (pending) await pending.wait
      return error ? json({ error }, 503) : json({ users })
    }
    const user = endpoint?.match(/^users\/([a-f0-9]{32})\/images$/)?.[1]
    if (user) {
      const pending = state.imageGates.get(user)
      const error = state.imagesError
      const images = state.images.get(user) || []
      if (pending) await pending.wait
      return error ? json({ error }, 503) : json({ images })
    }
    if (endpoint?.match(/^images\/[a-f0-9]{32}\/0$/)) {
      state.protectedImages.push(path)
      return route.fulfill({ contentType: 'image/webp', body: imageBytes })
    }
    return json({ error: `Unexpected fixture endpoint: ${path}` }, 404)
  })
  await page.goto(`/manage/${adminPath}`)
  if (authenticated) await expect(page.getByRole('heading', { name: '额度总览', exact: true })).toBeVisible()
  else await expect(page.getByRole('heading', { name: '登录管理工作台' })).toBeVisible()
  return state
}

async function openWorks(page: Page) {
  await page.getByRole('button', { name: '用户作品', exact: true }).click()
  await expect(page.getByRole('heading', { name: '用户作品', exact: true })).toBeVisible()
}

const account = (page: Page, id: string) => page.getByRole('button', { name: `账户 ${id.slice(0, 12)}` })
const images = (page: Page) => page.getByRole('img', { name: '用户作品', exact: true })
async function expectDecoded(image: Locator) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => {
    const img = element as HTMLImageElement
    return img.complete && img.naturalWidth > 0
  })).toBe(true)
}

test('the admin header keeps the Jianlai name and renders the shield dog brand asset', async ({ page }) => {
  await fixture(page)
  const header = page.locator('.admin-brand')
  await expect(header).toContainText('剑来 · 管理中台')
  const logo = header.locator('img')
  await expectDecoded(logo)
  const response = await page.request.get(await logo.evaluate(element => (element as HTMLImageElement).currentSrc))
  expect(response.ok()).toBe(true)
  expect(await response.body()).toEqual(imageBytes)
})

test('login loads nullable visitors, auto-selects an account with works and uses protected local images', async ({ page }) => {
  const state = await fixture(page, false)
  await page.getByRole('textbox', { name: '管理员账号' }).fill('fixture-admin')
  await page.getByLabel('密码', { exact: true }).fill('fixture-password-only')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '额度总览', exact: true })).toBeVisible()
  await expect(page.getByText('用户可见期 14 天 · 管理员保留期 30 天。', { exact: false })).toBeVisible()
  await openWorks(page)
  await expect(account(page, visitor)).toBeVisible()
  await expect(account(page, firstUser)).toHaveClass(/active/)
  await expectDecoded(images(page))
  await expect(images(page)).toHaveAttribute('src', new RegExp(`/api/admin/${adminPath}/images/${firstJob}/0$`))
  expect(state.loginBody).toEqual({ username: 'fixture-admin', password: 'fixture-password-only' })
  expect(state.mutations).toEqual(['POST login'])
  expect(state.protectedImages.some(path => path.endsWith(`/images/${firstJob}/0`))).toBe(true)
  expect(state.requests.every(path => path.includes(`/api/admin/${adminPath}/`))).toBe(true)
})

test('an expired OSS preview falls back to the protected image and download URL', async ({ page }) => {
  const state = await fixture(page)
  state.images.set(firstUser, [{ ...artwork(firstJob, 'https://admin-oss.invalid/expired.webp'), downloadUrl: 'https://admin-oss.invalid/expired-original.png' }])
  await openWorks(page)
  await expectDecoded(images(page))
  await expect(images(page)).toHaveAttribute('src', new RegExp(`/api/admin/${adminPath}/images/${firstJob}/0$`))
  await expect(images(page).locator('..')).toHaveAttribute('href', new RegExp(`/api/admin/${adminPath}/images/${firstJob}/0(?:\\?.*)?$`))
  expect(state.ossRequests).toContain('https://admin-oss.invalid/expired.webp')
  expect(state.protectedImages.some(path => path.endsWith(`/images/${firstJob}/0`))).toBe(true)
  expect(state.mutations).toEqual([])
})

test('directory refresh distinguishes loading, failure, retry and genuinely empty results', async ({ page }) => {
  const state = await fixture(page)
  await openWorks(page)
  await expectDecoded(images(page))
  const pending = gate()
  state.directoryGate = pending
  state.directoryError = 'fixture directory temporarily unavailable'
  await page.getByRole('button', { name: '刷新目录', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '正在读取账户目录…' })).toBeVisible()
  await expect(page.getByText('暂无保留作品', { exact: true })).toHaveCount(0)
  pending.release()
  await expect(page.getByRole('alert').filter({ hasText: state.directoryError })).toBeVisible()
  await expect(page.getByText('暂无保留作品', { exact: true })).toHaveCount(0)
  state.directoryGate = null
  state.directoryError = ''
  await page.getByRole('button', { name: '重试账户目录', exact: true }).click()
  await expect(account(page, firstUser)).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'fixture directory temporarily unavailable' })).toHaveCount(0)
  state.users = []
  await page.getByRole('button', { name: '刷新目录', exact: true }).click()
  await expect(page.getByText('暂无保留作品', { exact: true })).toBeVisible()
  expect(state.mutations).toEqual([])
})

test('account works distinguish loading, error with retry, and empty results', async ({ page }) => {
  const state = await fixture(page)
  await openWorks(page)
  await expectDecoded(images(page))
  const pending = gate()
  state.imageGates.set(secondUser, pending)
  state.imagesError = 'fixture images temporarily unavailable'
  await account(page, secondUser).click()
  await expect(page.getByRole('status').filter({ hasText: '正在读取用户作品…' })).toBeVisible()
  await expect(page.getByText('该账户当前没有保留作品', { exact: true })).toHaveCount(0)
  pending.release()
  await expect(page.getByRole('alert').filter({ hasText: state.imagesError })).toBeVisible()
  await expect(page.getByText('该账户当前没有保留作品', { exact: true })).toHaveCount(0)
  state.imageGates.delete(secondUser)
  state.imagesError = ''
  await page.getByRole('button', { name: /重试|重新加载/ }).click()
  await expectDecoded(images(page))
  await expect(images(page)).toHaveAttribute('src', new RegExp(`${secondJob}/0$`))
  await account(page, visitor).click()
  await expect(page.getByText('该账户当前没有保留作品', { exact: true })).toBeVisible()
  await expect(images(page)).toHaveCount(0)
  expect(state.mutations).toEqual([])
})

test('a late response from another account cannot replace the selected account works', async ({ page }) => {
  const state = await fixture(page)
  await openWorks(page)
  await expectDecoded(images(page))
  const pending = gate()
  state.imageGates.set(secondUser, pending)
  await account(page, secondUser).click()
  await expect.poll(() => state.requests.filter(path => path.endsWith(`/users/${secondUser}/images`)).length).toBeGreaterThan(0)
  await account(page, firstUser).click()
  await expectDecoded(images(page))
  const lateResponse = page.waitForResponse(response => response.url().endsWith(`/users/${secondUser}/images`))
  pending.release()
  await (await lateResponse).finished()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(account(page, firstUser)).toHaveClass(/active/)
  await expect(images(page)).toHaveAttribute('src', new RegExp(`${firstJob}/0$`))
  await expect(images(page)).toHaveCount(1)
  expect(state.mutations).toEqual([])
})

test('template and account searches remain independent across tabs', async ({ page }) => {
  const state = await fixture(page)
  await page.getByRole('button', { name: '模板管理', exact: true }).click()
  await page.getByPlaceholder('搜索模板名称或标签').fill('no-such-template-fixture')
  await expect(page.getByText('没有符合条件的模板。', { exact: true })).toBeVisible()
  await openWorks(page)
  await expect(page.getByPlaceholder('筛选账户')).toHaveValue('')
  await expect(account(page, firstUser)).toBeVisible()
  await page.getByPlaceholder('筛选账户').fill(secondUser.slice(0, 12))
  await expect(account(page, secondUser)).toBeVisible()
  await expect(account(page, firstUser)).toHaveCount(0)
  await page.getByRole('button', { name: '模板管理', exact: true }).click()
  await expect(page.getByPlaceholder('搜索模板名称或标签')).toHaveValue('no-such-template-fixture')
  await page.getByPlaceholder('搜索模板名称或标签').fill('橙子')
  await expect(page.getByText('橙子海报', { exact: true })).toBeVisible()
  await openWorks(page)
  await expect(page.getByPlaceholder('筛选账户')).toHaveValue(secondUser.slice(0, 12))
  expect(state.mutations).toEqual([])
})

test('unordered accounts use newest creation first, put null dates last and preserve order when filtered', async ({ page }) => {
  const noWorks = '3'.repeat(32)
  const anotherOldUser = `22${'4'.repeat(30)}`
  const state = await fixture(page, true, [
    { id: visitor, imageCount: 0, lastCreated: null },
    { id: secondUser, imageCount: 1, lastCreated: now - 1000 },
    { id: noWorks, imageCount: 0, lastCreated: null },
    { id: anotherOldUser, imageCount: 1, lastCreated: now - 2000 },
    { id: firstUser, imageCount: 1, lastCreated: now },
  ])
  await openWorks(page)
  const list = page.getByRole('region', { name: '用户列表', exact: true })
  const labels = () => list.getByRole('button').evaluateAll(buttons => buttons.map(button => button.textContent))
  await expect(account(page, firstUser)).toHaveClass(/active/)
  await expectDecoded(images(page))
  await expect.poll(labels).toEqual([
    expect.stringContaining(firstUser.slice(0, 12)),
    expect.stringContaining(secondUser.slice(0, 12)),
    expect.stringContaining(anotherOldUser.slice(0, 12)),
    expect.stringContaining(visitor.slice(0, 12)),
    expect.stringContaining(noWorks.slice(0, 12)),
  ])
  await page.getByPlaceholder('筛选账户').fill('22')
  await expect(list.getByRole('button')).toHaveCount(2)
  await expect(list.getByRole('button').nth(0)).toContainText(secondUser.slice(0, 12))
  await expect(list.getByRole('button').nth(1)).toContainText(anotherOldUser.slice(0, 12))
  expect(state.requests.some(path => path.endsWith(`/users/${firstUser}/images`))).toBe(true)
  expect(state.mutations).toEqual([])
})

test('a long account directory scrolls independently and remains reachable on mobile', async ({ page, isMobile }) => {
  const manyUsers = Array.from({ length: 60 }, (_, index) => ({
    id: (index + 100).toString(16).padStart(32, '0'), imageCount: 0, lastCreated: null,
  }))
  const state = await fixture(page, true, [directory[1], ...manyUsers])
  state.images.set(firstUser, Array.from({ length: 12 }, (_, index) => artwork((index + 500).toString(16).padStart(32, '0'))))
  await openWorks(page)
  await account(page, firstUser).click()
  await expect(images(page)).toHaveCount(12)
  await expectDecoded(images(page).first())
  const list = page.getByRole('region', { name: '用户列表', exact: true })
  const works = page.getByRole('region', { name: '用户作品', exact: true })
  await expect(list.getByRole('button')).toHaveCount(61)
  const metrics = await list.evaluate(element => ({ height: element.clientHeight, fullHeight: element.scrollHeight }))
  expect(metrics.fullHeight).toBeGreaterThan(metrics.height)
  if (isMobile) {
    expect(metrics.height).toBeLessThanOrEqual(Math.min(page.viewportSize()!.height * 0.32, 260) + 1)
  }
  await list.scrollIntoViewIfNeeded()
  await list.hover()
  await works.evaluate(element => { element.scrollTop = 80 })
  await expect.poll(() => works.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const before = await works.evaluate(element => ({
    y: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height,
    scrollTop: element.scrollTop, pageY: window.scrollY,
  }))
  await page.mouse.wheel(0, 480)
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const after = await works.evaluate(element => ({
    y: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height,
    scrollTop: element.scrollTop, pageY: window.scrollY,
  }))
  expect(after).toEqual(before)
  // Reaching the bottom also checks scroll chaining cannot move the image pane.
  await list.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.mouse.wheel(0, 480)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await works.evaluate(element => ({
    y: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height,
    scrollTop: element.scrollTop, pageY: window.scrollY,
  }))).toEqual(before)
  const last = list.getByRole('button').last()
  await expect(last).toBeInViewport()
  await last.click()
  await expect(page.getByText('该账户当前没有保留作品', { exact: true })).toBeVisible()
  expect(state.mutations).toEqual([])
})
