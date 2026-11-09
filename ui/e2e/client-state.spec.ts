import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const plan = { prompt: '恢复原计划', text: '', size: 'auto', quality: 'medium', count: 2, useReference: false }
const job = { type: 'job', id: 'old-card', jobId: 'old-job', requestKey: 'old-key', status: 'running', plan, images: [], started: Date.now(), created: 1 }
const proposal = { type: 'assistant', id: 'proposal', text: '原计划', status: 'done', source: '原计划', plan, planState: 'open', created: 1 }
async function fixture(page: Page, items: unknown[], activeJobId?: string, activeRequestKey = 'old-key') {
  let status = 'running'
  let generatedStatus = 'done'
  let generates = 0
  let rejectGenerate = false
  let rejectionStatus = 0
  const requestKeys: string[] = []
  const requests: { references: string[]; count: number }[] = []
  await page.addInitScript((initial) => {
    if (!localStorage.getItem('fixture-seeded')) {
      localStorage.setItem('jianlai-chat:v1:state-account', JSON.stringify(initial))
      localStorage.setItem('fixture-seeded', 'yes')
    }
  }, items)
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = {}
    if (path.endsWith('/bootstrap')) body = { accountId: 'state-account', availableCents: 5000, imagePriceCents: 30, activeJob: activeJobId ? { id: activeJobId, status: 'running', requestKey: activeRequestKey } : null, capabilities: { sizes: [{ value: 'auto', label: '自动' }], qualities: [{ value: 'medium', label: '精细' }] } }
    else if (path.endsWith('/history') || path.endsWith('/videos')) body = { records: [] }
    else if (path.endsWith('/chat') && route.request().method() === 'POST') {
      await route.fulfill({ contentType: 'text/event-stream', body: `event: delta\ndata: {"text":"不参考原图，另画两张"}\n\nevent: plan\ndata: ${JSON.stringify(plan)}\n\nevent: done\ndata: {}\n\n` }); return
    }
    else if (path.endsWith('/chat')) body = { used: 0, limit: 50 }
    else if (path.endsWith('/generate')) {
      generates++
      requestKeys.push(route.request().postDataJSON().requestKey)
      requests.push(route.request().postDataJSON())
      if (rejectGenerate) { await route.abort('failed'); return }
      if (rejectionStatus) { await route.fulfill({ status: rejectionStatus, contentType: 'application/json', body: JSON.stringify({ error: '请求被明确拒绝' }) }); return }
      body = { id: `new-job${generates === 1 ? '' : `-${generates}`}`, status: 'running' }
    }
    else if (path.endsWith('/jobs/by-request')) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: '任务不存在' }) }); return
    }
    else if (path.includes('/jobs/new-job-')) body = { id: path.split('/').at(-1), status: 'done', charged: .3, availableCents: 4970, images: [{ index: 0, url: '/fixture.png', previewUrl: '/fixture.png', downloadUrl: '/fixture.png' }] }
    else if (path.includes('/jobs/')) {
      const jobStatus = path.endsWith('/new-job') ? generatedStatus : status
      body = { id: path.endsWith('/new-job') ? 'new-job' : 'old-job', status: jobStatus, phase: jobStatus === 'failed' ? 'failed' : undefined, error: jobStatus === 'done' ? '第二张生成失败' : jobStatus === 'failed' ? '上游失败' : undefined, charged: jobStatus === 'failed' ? 0 : .3, availableCents: 4970, images: jobStatus === 'running' ? [] : [{ index: 0, url: '/fixture.png', previewUrl: '/fixture.png', downloadUrl: '/fixture.png' }] }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { setStatus: (next: string) => { status = next }, setGeneratedStatus: (next: string) => { generatedStatus = next }, generates: () => generates, requestKeys, requests, setRejectionStatus: (next: number) => { rejectionStatus = next }, setGenerateFailure: (next: boolean) => { rejectGenerate = next } }
}

test('stopping preserves the job and resumes its actual charged partial result without regenerating', async ({ page }) => {
  const f = await fixture(page, [job])
  await page.goto('/')
  await page.getByRole('button', { name: '停止等待' }).click()
  await expect(page.getByRole('alert')).toContainText('尚未取消服务端任务')
  await expect(page.getByText('任务已失败，未扣费。')).toHaveCount(0)
  f.setStatus('done')
  await page.getByRole('button', { name: '继续查询' }).click()
  await expect(page.getByRole('alert')).toContainText('已交付 1/2 张')
  await expect(page.getByRole('alert')).toContainText('第二张生成失败')
  await expect(page.getByText(/实际费用 ¥0.30/)).toBeVisible()
  expect(f.generates()).toBe(0)
})

test('legacy failed stopped cards reconcile after reload and cannot restart a running task', async ({ page }) => {
  const f = await fixture(page, [{ ...job, status: 'failed', error: '已停止等待' }])
  await page.goto('/')
  await expect(page.getByRole('button', { name: '停止等待' })).toBeVisible()
  await expect(page.getByRole('button', { name: '按原方案重新生成' })).toHaveCount(0)
  await page.reload()
  f.setStatus('done')
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(f.generates()).toBe(0)
})

test('retrying confirmed failure leaves the old card terminal and the next plan usable', async ({ page }) => {
  const f = await fixture(page, [{ ...job, status: 'failed', phase: 'failed', chargedCents: 0 }, proposal])
  f.setStatus('failed')
  await page.goto('/')
  await page.getByRole('button', { name: '按原方案重新生成' }).click()
  await expect.poll(f.generates).toBe(1)
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  await expect(page.getByText(/正在提交/)).toHaveCount(0)
  await expect(page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true })).toBeEnabled()
})

test('a refreshed upload plan rebinds a file in place without another chat', async ({ page }) => {
  const f = await fixture(page, [{ ...proposal, plan: { ...plan, useReference: true, count: 1 }, reference: { kind: 'upload', id: 'private-ref', name: 'old.png', preview: '' } }])
  await page.goto('/')
  const card = page.getByRole('region', { name: '生成方案' })
  await expect(card.locator('details')).not.toHaveAttribute('open', '')
  await expect(card.getByLabel('重新绑定参考图')).toBeVisible()
  await expect(card.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; return canvas.toDataURL('image/png').split(',')[1] })
  await card.getByLabel('重新绑定参考图').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await expect(card.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
  await expect(card.getByLabel('画面描述')).toHaveValue('恢复原计划')
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(f.generates).toBe(1)
  const stored = await page.evaluate(() => localStorage.getItem('jianlai-chat:v1:state-account'))
  expect(stored).not.toContain('base64')
})


test('an ambiguous submit retries the same request key and reuses its card', async ({ page }) => {
  const f = await fixture(page, [proposal])
  f.setGenerateFailure(true)
  await page.goto('/')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '按原请求继续提交' })).toBeVisible()
  f.setGenerateFailure(false)
  await page.getByRole('button', { name: '按原请求继续提交' }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(f.requestKeys).toHaveLength(2)
  expect(new Set(f.requestKeys).size).toBe(1)
  await expect(page.getByText(/正在提交/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '按原请求继续提交' })).toHaveCount(0)
})


test('bootstrap reconnects an interrupted submit to the active server job without reposting', async ({ page }) => {
  const f = await fixture(page, [{ ...job, jobId: undefined, status: 'unknown', error: '提交超时' }], 'old-job')
  f.setStatus('done')
  await page.goto('/')
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(f.generates()).toBe(0)
})


test('an explicit plan without reference keeps two images even when a file was uploaded', async ({ page }) => {
  const f = await fixture(page, [])
  await page.goto('/')
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; return canvas.toDataURL('image/png').split(',')[1] })
  await page.locator('input[type=file]').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await page.getByRole('textbox', { name: '描述你想要的画面' }).fill('不参考原图，另画两张')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const card = page.getByRole('region', { name: '生成方案' })
  await card.locator('summary').filter({ hasText: '编辑方案' }).click()
  await expect(card.getByRole('combobox', { name: '张数' })).toContainText('2 张')
  await expect(card.getByRole('combobox', { name: '张数' })).toBeEnabled()
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(f.generates).toBe(1)
  expect(f.requests[0].references).toEqual([])
  expect(f.requests[0].count).toBe(2)
})


for (const result of ['failed', 'unknown'] as const) {
  test(`an uploaded submitted ${result} task rebinds after refresh and retries with the correct key`, async ({ page }) => {
    const uploadPlan = { ...proposal, plan: { ...plan, count: 1, useReference: true }, reference: { kind: 'upload', id: 'same-private-ref', name: 'original.png', preview: '' } }
    const f = await fixture(page, [uploadPlan])
    if (result === 'failed') f.setGeneratedStatus('failed')
    else f.setGenerateFailure(true)
    await page.goto('/')
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; return canvas.toDataURL('image/png').split(',')[1] })
    const file = { name: 'original.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }
    await page.getByRole('region', { name: '生成方案' }).getByLabel('重新绑定参考图').setInputFiles(file)
    await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
    const retry = result === 'failed' ? '按原方案重新生成' : '按原请求继续提交'
    await expect(page.getByRole('button', { name: retry })).toBeVisible()
    await page.reload()
    if (result === 'failed') await expect(page.getByRole('button', { name: retry })).toBeDisabled()
    else {
      await expect(page.getByRole('button', { name: retry })).toBeEnabled()
      await page.getByRole('button', { name: retry }).click()
      await expect(page.getByRole('alert')).toContainText('原请求结果仍未知')
      await expect(page.getByRole('alert')).toContainText('参考图已失效，请重新上传')
      expect(f.generates()).toBe(1)
      await expect.poll(async () => page.evaluate(() => {
        const items = JSON.parse(localStorage.getItem('jianlai-chat:v1:state-account') || '[]')
        return items.filter((item: { type: string }) => item.type === 'job').map((item: { status: string; requestKey: string }) => ({ status: item.status, requestKey: item.requestKey }))
      })).toEqual([{ status: 'unknown', requestKey: f.requestKeys[0] }])
    }
    await page.getByLabel('重新绑定任务参考图').setInputFiles(file)
    await expect(page.getByRole('button', { name: retry })).toBeEnabled()
    if (result === 'unknown') f.setGeneratedStatus('done')
    f.setGenerateFailure(false)
    await page.getByRole('button', { name: retry }).click()
    await expect.poll(f.generates).toBe(2)
    await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
    expect(f.requests[1].references).toEqual(f.requests[0].references)
    expect(f.requests[1].references).toHaveLength(1)
    if (result === 'failed') expect(f.requestKeys[1]).not.toBe(f.requestKeys[0])
    else expect(f.requestKeys[1]).toBe(f.requestKeys[0])
    const state = await page.evaluate(() => localStorage.getItem('jianlai-chat:v1:state-account'))
    expect(state).not.toContain('base64')
  })
}


test('a confirmed HTTP rejection creates no task and retries with its original key', async ({ page }) => {
  const f = await fixture(page, [proposal])
  f.setRejectionStatus(413)
  await page.goto('/')
  await page.getByRole('region', { name: '生成方案' }).getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('未创建生成任务')
  await expect(page.getByRole('alert')).not.toContainText('服务端确认失败')
  await expect(page.getByRole('alert')).toContainText('未扣费')
  f.setRejectionStatus(0)
  await page.getByRole('button', { name: '按原请求继续提交' }).click()
  await expect.poll(f.generates).toBe(2)
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(f.requestKeys[0]).toBe(f.requestKeys[1])
})


test('bootstrap never associates a different tab task with an interrupted request', async ({ page }) => {
  const f = await fixture(page, [{ ...job, status: 'submitting', jobId: undefined }], 'another-tab-job', 'another-tab-key')
  await page.goto('/')
  await expect(page.getByRole('button', { name: '按原请求继续提交' })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止等待' })).toHaveCount(0)
  expect(f.generates()).toBe(0)
})

test('refresh during submission replays the original request key after the active job has finished', async ({ page }) => {
  const f = await fixture(page, [{ ...job, status: 'submitting', jobId: undefined }])
  await page.goto('/')
  await page.getByRole('button', { name: '按原请求继续提交' }).click()
  await expect(page.getByText(/已完成 · 1 张/)).toBeVisible()
  expect(f.requestKeys).toEqual(['old-key'])
})
