import { fileURLToPath } from 'node:url'
import { expect, test as base } from '@playwright/test'

const test = base.extend<{ safety: void }>({
  safety: [async ({ page }, use) => {
    const apiCalls: string[] = []
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', route => {
      apiCalls.push(route.request().url())
      return route.abort()
    })
    await use()
    expect(apiCalls, '交互样板不能调用生产 API').toEqual([])
    expect(errors, '页面不能出现未捕获异常').toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '页面不能横向溢出').toBe(true)
  }, { auto: true }],
})

const screenshotDir = '/tmp/jianlai-ui-refresh'

test('idea becomes an editable plan and only explicit confirmation starts generation', async ({ page }, info) => {
  await page.clock.install()
  await page.goto('/design')
  await expect(page).toHaveTitle('剑来生图')
  await expect(page.getByRole('heading', { name: '把想法，变成画面。' })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await page.screenshot({ path: `${screenshotDir}/welcome-${info.project.name}.png`, fullPage: true })

  const idea = '为一杯春日抹茶做一张海报'
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill(idea)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const plan = page.getByRole('region', { name: '生成方案', exact: true })
  await expect(plan).toContainText(idea)
  await expect(page.getByRole('region', { name: '生成状态' })).toHaveCount(0)
  await page.getByRole('button', { name: '编辑描述', exact: true }).click()
  const description = page.getByRole('textbox', { name: '画面描述', exact: true })
  await description.fill('')
  await expect(page.getByRole('button', { name: '确认并生成' })).toBeDisabled()
  await description.fill('春日抹茶海报，柔和自然光、奶白背景，保留标题留白。')
  await page.getByRole('button', { name: '完成编辑', exact: true }).click()
  await page.getByRole('combobox', { name: '画幅', exact: true }).selectOption('1024x1024')
  await page.getByRole('combobox', { name: '质量', exact: true }).selectOption('high')
  await page.getByRole('combobox', { name: '数量', exact: true }).selectOption('2')
  await page.getByText('画面文字与参考图', { exact: true }).click()
  await page.getByRole('textbox', { name: '画面文字', exact: true }).fill('春日，一口清新')
  await expect(plan).toContainText('¥0.60')
  await page.clock.runFor(2500)
  await expect(plan).toBeVisible()
  await expect(page.getByRole('region', { name: '生成结果' })).toHaveCount(0)
  await page.screenshot({ path: `${screenshotDir}/plan-${info.project.name}.png`, fullPage: true })

  await page.getByRole('button', { name: '确认并生成' }).click()
  await expect(page.getByRole('status')).toContainText('模拟生成中')
  await page.clock.runFor(2300)
  const result = page.getByRole('region', { name: '生成结果' })
  await expect(result).toContainText('已完成 · 2 张示意作品')
  await expect(result).toContainText('示意费用 ¥0.60')
  await expect(result.getByRole('button', { name: /放大查看作品/ })).toHaveCount(2)
  await expect(page.getByText('此样板不会发起生成或扣费。', { exact: false })).toBeVisible()
  await page.screenshot({ path: `${screenshotDir}/result-${info.project.name}.png`, fullPage: true })

  await page.getByRole('button', { name: '继续修改', exact: true }).click()
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '描述你想要的画面' })).toHaveValue('保留画面主体，帮我调整背景与配色。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(plan).toBeVisible()
  await expect(page.getByRole('combobox', { name: '数量', exact: true })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '数量', exact: true })).toHaveValue('1')
  await expect(page.getByRole('region', { name: '生成状态' })).toHaveCount(0)
  await page.getByRole('button', { name: '确认并生成' }).click()
  await page.clock.runFor(2300)
  await expect(result).toContainText('已完成 · 1 张示意作品')
})

test('stopping local waiting preserves unknown outcome until the original task is queried', async ({ page }) => {
  await page.clock.install()
  await page.goto('/design')
  await page.getByRole('combobox', { name: '预览状态' }).selectOption('running')
  await expect(page.getByRole('region', { name: '生成状态' })).toBeVisible()
  await page.getByRole('button', { name: '停止等待', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('停止等待不等于取消任务。最终结果和费用仍待确认')
  await page.clock.runFor(2500)
  await expect(page.getByRole('region', { name: '生成结果' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '预览状态' })).toHaveValue('unknown')
  await page.getByRole('button', { name: '继续查询原任务', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('模拟生成中')
  await page.clock.runFor(2300)
  await expect(page.getByRole('region', { name: '生成结果' })).toContainText('已完成')
})

test('partial and failed previews explain delivery and charges before retry', async ({ page }) => {
  await page.goto('/design')
  await page.getByRole('combobox', { name: '预览状态' }).selectOption('partial')
  const result = page.getByRole('region', { name: '生成结果' })
  await expect(result).toContainText('部分成功 · 已交付 1 / 2 张')
  await expect(result).toContainText('示意费用 ¥0.30')
  await expect(result).toContainText('另 1 张未交付，不计费')
  await expect(result.getByRole('button', { name: /放大查看作品/ })).toHaveCount(1)
  await page.getByRole('combobox', { name: '预览状态' }).selectOption('failed')
  await expect(page.getByRole('alert')).toContainText('服务端已确认任务失败，未扣费')
  await expect(result).toHaveCount(0)
  await page.getByRole('button', { name: '查看方案', exact: true }).click()
  await expect(page.getByRole('region', { name: '生成方案', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '生成状态' })).toHaveCount(0)
})

test('reference upload locks count and removing it restores the option', async ({ page }) => {
  await page.goto('/design')
  await page.getByRole('combobox', { name: '预览状态' }).selectOption('plan')
  await page.getByText('画面文字与参考图', { exact: true }).click()
  await page.getByLabel('方案参考图', { exact: true }).setInputFiles(fileURLToPath(new URL('../src/design/orange-example.webp', import.meta.url)))
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '数量', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '确认并生成' })).toBeEnabled()
  await page.getByRole('button', { name: '移除当前参考图', exact: true }).click()
  await expect(page.getByRole('img', { name: '当前参考图', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '数量', exact: true })).toBeEnabled()
})

test('mobile drawers close on Escape and restore trigger focus', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Only narrow layouts use navigation and artwork drawers')
  await page.goto('/design')
  for (const [trigger, title] of [['打开主菜单', '主菜单'], ['打开作品', '作品']]) {
    const button = page.getByRole('button', { name: trigger, exact: true })
    await button.click()
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Tab')
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
  }
})

test('narrow, tablet and enlarged text keep primary actions reachable', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'One responsive pass covers fixed CSS viewports')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/design')
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(page.getByRole('heading', { name: '把想法，变成画面。' })).toBeVisible()
    await page.getByRole('combobox', { name: '预览状态' }).selectOption('plan')
    const confirm = page.getByRole('button', { name: '确认并生成' })
    await confirm.scrollIntoViewIfNeeded()
    await expect(confirm).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('combobox', { name: '预览状态' }).selectOption('welcome')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await page.getByRole('combobox', { name: '预览状态' }).selectOption('plan')
  const confirm = page.getByRole('button', { name: '确认并生成' })
  await confirm.scrollIntoViewIfNeeded()
  await expect(confirm).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
