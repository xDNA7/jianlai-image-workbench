import { expect, test } from 'bun:test'
import { briefStart, imageIntent, previousReference, withoutReference } from '../src/chat/context'
import { loadThread, saveThread, toChatMessages } from '../src/chat/store'
import type { JobItem, ThreadItem, UserItem } from '../src/chat/types'
const user = (text: string, extra: Partial<UserItem> = {}): UserItem => ({ type: 'user', id: text, text, created: 1, ...extra })
const job = (id: string): JobItem => ({ type: 'job', id, jobId: id, requestKey: id, plan: { prompt: id, text: '', count: 1, useReference: false, size: 'auto', quality: 'medium' }, status: 'done', started: 1, created: 1, images: [{ id, jobId: id, index: 0, preview: '/preview', download: '/download', prompt: id }] })
const old = '1'.repeat(32), latest = '2'.repeat(32)
test('independent creation resets old context while changes preserve it', () => {
  for (const text of ['生成一张新图：海边', '帮我画一只猫', '不参考原图，另画两张', '生成新图', '改为完全独立的一片森林', '生成一张新海报，添加标题：春日', '帮我画一只猫，保留手绘质感']) expect(imageIntent(text)).toBe('new')
  expect(withoutReference('不要用参考图，生成一只猫')).toBe(true)
  for (const text of ['改成黄色', '上一张重新生成', '换一个新风格', '不要新图，改上一张', '脚没动起来']) expect(imageIntent(text)).toBe('edit')
  const items = [user('旧话题'), job(old), user('生成一张新图：海边'), user('再亮一点')]
  expect(toChatMessages(items)).toEqual([{ role: 'user', content: '生成一张新图：海边' }, { role: 'user', content: '再亮一点' }])
  expect(previousReference(items)).toBeUndefined()
})
test('latest completed output wins over old reference and pending or failed jobs', () => {
  const items: ThreadItem[] = [user('画一只猫'), job(old), { type: 'assistant', id: 'a', created: 1, text: '待确认', source: '调整', status: 'done', reference: { kind: 'picked', url: '/old', preview: '', prompt: 'old' } }, job(latest), { ...job('3'.repeat(32)), status: 'unknown' }]
  expect(previousReference(items)).toMatchObject({ kind: 'previous', url: `/jianlai/api/jobs/${latest}/images/0` })
  items.push({ type: 'assistant', id: 'b', created: 2, text: '待确认B', source: '调整B', status: 'done', reference: { kind: 'picked', url: '/selected-b', preview: '', prompt: 'B' } })
  expect(previousReference(items)).toMatchObject({ url: '/selected-b' })
})
test('new uploaded brief cannot fall back to older artwork; boundary survives reload', () => {
  const items: ThreadItem[] = [user('旧话题'), job(old), user('照片变成黏土', { contextStart: true, reference: { kind: 'upload', id: 'up', name: 'new.png', preview: 'private pixels' } })]
  expect(briefStart(items)).toBe(2)
  expect(previousReference(items)).toBeUndefined()
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  saveThread('test', items, storage)
  const restored = loadThread('test', storage)
  expect(toChatMessages(restored)).toEqual([{ role: 'user', content: '照片变成黏土' }])
  expect(JSON.stringify(restored)).not.toContain('private pixels')
  expect(previousReference(restored)).toBeUndefined()
})
