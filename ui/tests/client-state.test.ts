import { expect, test } from 'bun:test'
import { sanitize } from '../src/chat/store'
import type { JobItem } from '../src/chat/types'
const job: JobItem = { type: 'job', id: 'card', jobId: 'server', requestKey: 'key', status: 'failed', plan: { prompt: 'test', text: '', size: 'auto', quality: 'medium', count: 2, useReference: false }, images: [], created: 1, started: 1 }
test('legacy stopped cards recover the server task instead of assuming no charge', () => {
  expect(sanitize([{ ...job, error: '已停止等待。任务仍在服务端运行' }])[0]).toMatchObject({ status: 'running', jobId: 'server' })
  expect(sanitize([{ ...job, status: 'unknown' }])[0]).toMatchObject({ status: 'running', jobId: 'server' })
})
test('a confirmed server failure remains terminal on refresh', () => {
  expect(sanitize([{ ...job, phase: 'failed' }])[0]).toMatchObject({ status: 'failed' })
})
test('refresh preserves the upload reference id and plan without private pixels', () => {
  const plan = { type: 'assistant' as const, id: 'plan', status: 'done' as const, source: 'test', text: '', created: 1, plan: job.plan, planState: 'open' as const, reference: { kind: 'upload' as const, id: 'ref', name: 'private.png', preview: 'data:image/png;base64,AAAA' } }
  expect(sanitize([plan])[0]).toMatchObject({ plan: job.plan, planState: 'open', reference: { id: 'ref', preview: '' } })
})

test('partial delivery shows expected count, actual cost and server reason', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { JobCard } = await import('../src/chat/JobCard')
  const html = renderToStaticMarkup(createElement(JobCard, {
    item: { ...job, status: 'done', chargedCents: 30, error: '第二张失败', images: [{ id: 'image', index: 0, preview: '/preview.png', download: '/image.png', prompt: 'test' }] },
    onOpen: () => {}, onEdit: () => {}, onStop: () => {}, onRetryPoll: () => {}, onRetryGeneration: () => {},
  }))
  expect(html).toContain('部分成功')
  expect(html).toContain('1/2')
  expect(html).toContain('实际费用 ¥0.30')
  expect(html).toContain('第二张失败')
})

test('a submitted uploaded job offers rebinding after refresh and blocks replay until bound', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { JobCard } = await import('../src/chat/JobCard')
  for (const status of ['failed', 'unknown'] as const) {
    const item = { ...job, jobId: status === 'unknown' ? undefined : job.jobId, status, phase: 'failed', plan: { ...job.plan, useReference: true }, reference: { kind: 'upload' as const, id: 'private-ref', name: 'original.png', preview: '' } }
    const html = renderToStaticMarkup(createElement(JobCard, { item, onOpen: () => {}, onEdit: () => {}, onStop: () => {}, onRetryPoll: () => {}, onRetryGeneration: () => {}, onRebindReference: async () => {} }))
    expect(html).toContain('重新绑定任务参考图')
    const replay = (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find((button) => /按原(?:方案重新生成|请求继续提交)/.test(button))
    expect(replay).toMatch(/(?:disabled=""|aria-disabled="true")/)
    expect(item.requestKey).toBe('key')
    expect(item.reference.id).toBe('private-ref')
  }
})

test('interrupted submits and legacy ambiguous failures preserve the original key as unknown', () => {
  for (const status of ['submitting', 'failed'] as const) {
    expect(sanitize([{ ...job, jobId: undefined, status, error: '提交被中断，未扣费' }])[0]).toMatchObject({
      status: 'unknown', requestKey: 'key', error: '提交被中断，尚未确认服务端是否接单；请先到画廊核对任务和费用',
    })
  }
})
