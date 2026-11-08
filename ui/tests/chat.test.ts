import { getPublicFigureNames, getPublicFigureContext, validatePlanFigureSources } from '../src/chat/public-figures'
import { describe, expect, test } from 'bun:test'
import { createSseParser, normalizePlan, parseCommonsSearch, validateCommonsResult, validateFigureSources } from '../src/chat/api'
import { advance, sliceChars } from '../src/chat/typewriter'
import {
  THREAD_LIMIT,
  isFavoriteImage,
  loadPrivateTemplates,
  makePrivateTemplate,
  savePrivateTemplates,
  toggleFavoriteKeys,
  loadThread,
  saveThread,
  threadKey,
  toChatMessages,
  trimThread,
} from '../src/chat/store'
import type { AssistantItem, JobItem, Plan, ThreadItem, UserItem } from '../src/chat/types'

function memory() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

const user = (id: string, text = 'hi'): UserItem => ({ type: 'user', id, text, created: 1 })
const reply = (id: string, over: Partial<AssistantItem> = {}): AssistantItem => ({
  type: 'assistant', id, text: '好的', status: 'done', source: 'hi', created: 2, ...over,
})
const plan = { prompt: '水乡', text: '', size: 'auto', quality: 'medium', count: 1 as const, useReference: false }
const job = (id: string, over: Partial<JobItem> = {}): JobItem => ({
  type: 'job', id, requestKey: 'k', plan, status: 'done', images: [], started: 1, created: 3, ...over,
})

describe('SSE parser', () => {
  test('splits events across arbitrary chunk boundaries', () => {
    const parse = createSseParser()
    const text = 'event: delta\ndata: {"text":"你"}\n\nevent: delta\ndata: {"text":"好"}\n\n'
    const events = [...text].flatMap((c) => parse(c))
    expect(events.map((e) => e.event)).toEqual(['delta', 'delta'])
    expect(JSON.parse(events[1].data).text).toBe('好')
  })

  test('handles CRLF and ignores comment-only blocks', () => {
    const parse = createSseParser()
    const events = parse(': ping\r\n\r\nevent: done\r\ndata: {}\r\n\r\n')
    expect(events).toEqual([{ event: 'done', data: '{}' }])
  })
})

describe('plan normalisation', () => {
  test('rejects empty prompts and forces one image for reference edits', () => {
    expect(normalizePlan({ prompt: '  ' })).toBeNull()
    expect(normalizePlan({ prompt: 'x', count: 2, useReference: true })?.count).toBe(1)
    expect(normalizePlan({ prompt: 'x', count: 2, useReference: false })?.count).toBe(2)
    expect(normalizePlan({ prompt: 'x' })?.quality).toBe('medium')
    expect(normalizePlan({ prompt: 'x', publicFigure: '周杰伦' })?.publicFigure).toBe('周杰伦')
    expect(normalizePlan({ prompt: 'x', publicFigure: '周杰伦', publicFigureVisual: false })?.publicFigureVisual).toBe(false)
    expect(normalizePlan({ prompt: 'x', publicFigure: 'a'.repeat(121) })?.publicFigure).toBeUndefined()
  })
})

describe('public image search results', () => {
  test('requires Commons source, Wikimedia image hosts, author, and license', () => {
    const results = parseCommonsSearch({ query: { pages: {
      '1': { title: 'File:Artist.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/thumb.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg', extmetadata: { Artist: { value: 'A. Photographer' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' } } }] },
      '2': { title: 'File:No-license.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/no-license.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:No-license.jpg', extmetadata: {} }] },
    } } })
    expect(results).toHaveLength(1)
    expect(validateCommonsResult(results[0])).toEqual(results[0])
    expect(validateCommonsResult({ ...results[0], imageUrl: 'https://example.com/a.jpg' })).toBeNull()
  })
})

describe('thread store', () => {
  test('is partitioned by account', () => {
    const storage = memory()
    saveThread('a', [user('1')], storage)
    expect(loadThread('a', storage)).toHaveLength(1)
    expect(loadThread('b', storage)).toEqual([])
    expect(threadKey('a')).not.toBe(threadKey('b'))
  })

  test('falls back to an empty thread for corrupt data', () => {
    const storage = memory()
    storage.setItem(threadKey('a'), '{not json')
    expect(loadThread('a', storage)).toEqual([])
    storage.setItem(threadKey('a'), '{"a":1}')
    expect(loadThread('a', storage)).toEqual([])
    storage.setItem(threadKey('a'), JSON.stringify([{ type: 'bogus', id: 'x' }, user('1')]))
    expect(loadThread('a', storage)).toHaveLength(1)
  })

  test('trims to the limit without starting on an orphaned reply', () => {
    const items: ThreadItem[] = []
    for (let i = 0; i < 150; i += 1) items.push(user(`u${i}`), reply(`a${i}`))
    const trimmed = trimThread(items)
    expect(trimmed.length).toBeLessThanOrEqual(THREAD_LIMIT)
    expect(trimmed[0].type).toBe('user')
  })

  test('marks interrupted work as failed after a reload', () => {
    const storage = memory()
    saveThread('a', [user('1'), reply('2', { status: 'streaming', text: '部分' }), job('3', { status: 'submitting' })], storage)
    const loaded = loadThread('a', storage)
    expect((loaded[1] as AssistantItem).status).toBe('error')
    expect((loaded[2] as JobItem).status).toBe('unknown')
  })

  test('drops uploaded reference previews before persisting', () => {
    const storage = memory()
    const ref = { kind: 'upload' as const, id: 'r', name: 'a.png', preview: 'data:image/png;base64,AAAA' }
    saveThread('a', [{ ...user('1'), reference: ref }], storage)
    expect(storage.getItem(threadKey('a'))).not.toContain('base64')
  })
})

describe('job recovery state', () => {
  test('clears a transient polling error when status is received again', async () => {
    const { clearJobQueryError } = await import('../src/chat/useWorkbench')
    const stale = job('job-1', { status: 'running', error: '查询任务失败：网络错误' })
    expect(clearJobQueryError(stale, 'running')).toMatchObject({ status: 'running' })
    expect(clearJobQueryError(stale, 'running')).not.toHaveProperty('error')
    expect(clearJobQueryError(stale, 'done')).toMatchObject({ status: 'done' })
    expect(clearJobQueryError(stale, 'done')).not.toHaveProperty('error')
  })
})

describe('conversation helpers', () => {
  test('only finished text turns go to the model', () => {
    const items: ThreadItem[] = [
      user('1', '画水乡'),
      reply('2', { text: '方案如下' }),
      job('3'),
      user('4', '改成黄昏'),
      reply('5', { status: 'error', text: '' }),
    ]
    expect(toChatMessages(items)).toEqual([
      { role: 'user', content: '画水乡' },
      { role: 'assistant', content: '方案如下' },
      { role: 'user', content: '改成黄昏' },
    ])
  })
})

describe('typewriter', () => {
  test('finishes a long reply in about 2.2 s and a short one at 40 chars/s', () => {
    expect(advance(0, 440, 1000)).toBeCloseTo(200)
    expect(advance(0, 440, 2200)).toBeCloseTo(440)
    expect(advance(0, 440, 2300)).toBe(440)
    expect(advance(0, 20, 250)).toBeCloseTo(10)
    expect(advance(20, 20, 100)).toBe(20)
  })

  test('never splits a surrogate pair and clamps the count', () => {
    expect(sliceChars('你好吗', 2.9)).toBe('你好')
    expect(sliceChars('a😀b', 2)).toBe('a')
    expect(sliceChars('a😀b', 3)).toBe('a😀')
    expect(sliceChars('abc', 99)).toBe('abc')
    expect(sliceChars('abc', -1)).toBe('')
  })
})

describe('favourites written by the previous UI', () => {
  const image = { id: 'job1-0', preview: 'https://oss/x/p.webp', download: 'https://oss/x/o.png' }

  test('a star saved under the image URL still matches', () => {
    expect(isFavoriteImage(['https://oss/x/o.png'], image)).toBe(true)
    expect(isFavoriteImage(['https://oss/x/p.webp'], image)).toBe(true)
    expect(isFavoriteImage(['job1-0'], image)).toBe(true)
    expect(isFavoriteImage(['https://oss/other.png'], image)).toBe(false)
  })

  test('toggling removes every legacy key, or adds the new id', () => {
    expect(toggleFavoriteKeys(['a', 'https://oss/x/o.png', 'job1-0'], image)).toEqual(['a'])
    expect(toggleFavoriteKeys(['a'], image)).toEqual(['a', 'job1-0'])
  })
})

describe('private templates', () => {
  const picture = { prompt: '水乡', text: '开业', preview: 'p', download: 'd' }

  test('round-trips in the shape the previous UI wrote', () => {
    const storage = memory()
    const made = makePrivateTemplate('  我的海报 ', picture, 123)
    expect(made).toEqual({
      id: 'private-123', title: '我的海报', prompt: '水乡', text: '开业', image: 'd', preview: 'p',
      private: true, category: 'mine',
    })
    savePrivateTemplates([made], storage)
    expect(loadPrivateTemplates(storage)).toEqual([made])
  })

  test('reads legacy entries and ignores corrupt data', () => {
    const storage = memory()
    storage.setItem('jianlai-private-templates', JSON.stringify([
      { id: 'private-1', title: '旧模板', prompt: 'x', image: 'i', preview: 'p', private: true, category: 'mine' },
      { title: 'no id' },
      null,
    ]))
    const list = loadPrivateTemplates(storage)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'private-1', text: '', private: true, category: 'mine' })
    storage.setItem('jianlai-private-templates', '{oops')
    expect(loadPrivateTemplates(storage)).toEqual([])
  })
})

describe('welcome suggestions', () => {
  test('every example is a self-contained sales poster prompt within the chat limit', async () => {
    const { SUGGESTIONS } = await import('../src/chat/ChatThread')
    expect(SUGGESTIONS.map((s) => s.label)).toEqual(['新品上市海报', '电商主图', '课程介绍图', '讲师介绍图', '销售活动海报', '业绩喜报'])
    for (const { label, prompt } of SUGGESTIONS) {
      expect(prompt.length).toBeGreaterThan(60)
      expect(prompt.length).toBeLessThanOrEqual(2000)
      expect(prompt).not.toMatch(/[\[\]【】{}]|XX|待定/)
      expect(label.length).toBeLessThanOrEqual(8)
    }
    expect(new Set(SUGGESTIONS.map((s) => s.label)).size).toBe(SUGGESTIONS.length)
  })
})

describe('position marks', () => {
  test('pointIn returns fractions of the frame and clamps outside it', async () => {
    const { pointIn } = await import('../src/chat/marks')
    const frame = { left: 100, top: 50, width: 200, height: 400 }
    expect(pointIn(frame, 200, 250)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointIn(frame, 0, 9999)).toEqual({ x: 0, y: 1 })
  })

  test('a drag becomes a box in any direction; a tiny drag does not', async () => {
    const { boxBetween } = await import('../src/chat/marks')
    const box = boxBetween({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.2 })!
    expect([box.x, box.y]).toEqual([0.2, 0.2])
    expect(box.w).toBeCloseTo(0.4)
    expect(box.h).toBeCloseTo(0.3)
    expect(boxBetween({ x: 0.5, y: 0.5 }, { x: 0.504, y: 0.7 })).toBeNull()
  })

  test('toApiAnnotations drops empty notes, trims, caps and keeps boxes inside the image', async () => {
    const { toApiAnnotations, newMark, incompleteCount, MAX_MARKS } = await import('../src/chat/marks')
    const point = { ...newMark({ type: 'point', x: 0.25, y: 0.4 }), note: '  改成红色  ' }
    const empty = newMark({ type: 'point', x: 0.5, y: 0.5 })
    const spill = { ...newMark({ type: 'area', x: 0.8, y: 0.9, w: 0.5, h: 0.5 }), note: '换背景' }
    expect(incompleteCount([point, empty, spill])).toBe(1)
    const out = toApiAnnotations([point, empty, spill])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'point', x: 0.25, y: 0.4, text: '改成红色' })
    expect(out[1]).toMatchObject({ type: 'box', x: 0.8, y: 0.9 })
    const box = out[1] as { w: number; h: number }
    expect(box.w).toBeCloseTo(0.2)
    expect(box.h).toBeCloseTo(0.1)
    const many = Array.from({ length: MAX_MARKS + 5 }, () => ({ ...newMark({ type: 'point', x: 0, y: 0 }), note: 'x' }))
    expect(toApiAnnotations(many)).toHaveLength(MAX_MARKS)
    const long = { ...newMark({ type: 'point', x: 0, y: 0 }), note: '字'.repeat(900) }
    expect((toApiAnnotations([long])[0] as { text: string }).text).toHaveLength(500)
  })
})

describe('zoom and placeholder sizing', () => {
  test('zoom steps fit -> 100% -> 200% -> 400% and stop at the ends', async () => {
    const { nextZoom } = await import('../src/chat/ZoomViewer')
    expect(nextZoom(0, 1)).toBe(1)
    expect(nextZoom(1, 1)).toBe(2)
    expect(nextZoom(2, 1)).toBe(4)
    expect(nextZoom(4, 1)).toBe(4)
    expect(nextZoom(1, -1)).toBe(0)
    expect(nextZoom(0, -1)).toBe(0)
    expect(nextZoom(3, 1)).toBe(1)
  })

  test('ratioNumber reads WxH and falls back to 3:2 for auto', async () => {
    const { ratioNumber } = await import('../src/chat/JobCard')
    expect(ratioNumber('1024x1536')).toBeCloseTo(2 / 3)
    expect(ratioNumber('1536x1024')).toBeCloseTo(1.5)
    expect(ratioNumber('auto')).toBe(1.5)
  })
})


describe('new upload context boundaries', () => {
  const uploaded = (id: string, text: string): UserItem => ({
    ...user(id, text), reference: { kind: 'upload', id: `ref-${id}`, name: `${id}.png`, preview: 'data:image/png;base64,private' },
  })

  test('keeps displayed history but excludes the previous image brief after a new upload', () => {
    const items: ThreadItem[] = [user('old', '旧场景和旧人物'), reply('old-reply', { text: '旧图是一位红衣人物' }), job('old-image'), uploaded('photo', '把照片里的人物放在海边')]
    expect(toChatMessages(items)).toEqual([{ role: 'user', content: '把照片里的人物放在海边' }])
    expect(items).toHaveLength(4)
    expect(items[0]).toEqual(user('old', '旧场景和旧人物'))
  })

  test('keeps follow-up discussion in the new image brief, and a second upload starts another one', () => {
    const items: ThreadItem[] = [user('old', '旧海报'), reply('old-reply'), uploaded('first', '第一张照片换蓝衣服'), reply('first-reply', { text: '第一张照片方案' }), user('follow-up', '衣服改成白色')]
    expect(toChatMessages(items)).toEqual([
      { role: 'user', content: '第一张照片换蓝衣服' },
      { role: 'assistant', content: '第一张照片方案' },
      { role: 'user', content: '衣服改成白色' },
    ])
    items.push(uploaded('second', '新照片换背景'))
    expect(toChatMessages(items)).toEqual([{ role: 'user', content: '新照片换背景' }])
  })

  test('restoring private uploads without persisted pixels preserves the context boundary', () => {
    const storage = memory()
    saveThread('a', [user('old', '旧人物'), reply('old-reply'), uploaded('new', '新照片的人物'), reply('new-reply'), user('follow', '改成户外场景')], storage)
    expect(storage.getItem(threadKey('a'))).not.toContain('private')
    expect(toChatMessages(loadThread('a', storage))).toEqual([
      { role: 'user', content: '新照片的人物' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '改成户外场景' },
    ])
  })
})


describe('public figure identity reference boundary', () => {
  const source = (file: string, entityId = 'Q26876') => ({ title: `File:${file}.jpg`, thumbUrl: `https://upload.wikimedia.org/thumb/${file}.jpg`, imageUrl: `https://upload.wikimedia.org/${file}.jpg`, sourceUrl: `https://commons.wikimedia.org/wiki/File:${file}.jpg`, artist: 'Photo Author', license: 'CC BY 4.0', entityId, personName: 'Taylor Swift' })
  test('accepts 2–4 distinct files tied to one person and rejects single or mixed people', () => {
    const images = [source('one'), source('two')]
    expect(validateFigureSources(images)).toEqual(images)
    expect(validateFigureSources(images.slice(0, 1))).toEqual([])
    expect(validateFigureSources([source('one'), source('two', 'Q42')])).toEqual([])
    expect(validateFigureSources([source('one'), source('one')])).toEqual([])
    expect(validateFigureSources(Array.from({ length: 5 }, (_, index) => source(String(index))))).toEqual([])
  })
  test('does not trust a saved source with missing identity, a redirect-like page or a forged host', () => {
    const first = source('one')
    for (const bad of [
      { ...source('two'), entityId: undefined },
      { ...source('two'), imageUrl: 'https://upload.wikimedia.org.evil.test/image.jpg' },
      { ...source('two'), imageUrl: 'https://upload.wikimedia.org:444/image.jpg' },
      { ...source('two'), sourceUrl: 'https://commons.wikimedia.org/wiki/File:two.jpg?redirect=elsewhere' },
      { ...source('two'), sourceUrl: 'https://commons.wikimedia.org/wiki/File:%zz' },
      { ...source('two'), personName: 123 },
    ]) expect(validateFigureSources([first, bad])).toEqual([])
  })
})


describe('multiple public figure references', () => {
  const source = (name: string, id: string, index: number) => ({ title: `File:${id}-${index}.jpg`, thumbUrl: `https://upload.wikimedia.org/${id}-${index}.jpg`, imageUrl: `https://upload.wikimedia.org/${id}-${index}.jpg`, sourceUrl: `https://commons.wikimedia.org/wiki/File:${id}-${index}.jpg`, artist: 'Author', license: 'CC BY', entityId: id, personName: name })
  const first = [source('厉娜', 'Q8992471', 1), source('厉娜', 'Q8992471', 2)]
  const second = [source('许飞', 'Q6701420', 1), source('许飞', 'Q6701420', 2)]
  const plan: Plan = { prompt: '两位歌手合照', text: '', quality: 'medium', size: 'auto', count: 1, useReference: false, publicFigureVisual: true, publicFigures: ['厉娜', '许飞'], publicFigureSources: [...second, ...first] }
  test('normalises separate names and bounded disambiguation context', () => {
    const normal = normalizePlan({ prompt: '两位歌手', publicFigureVisual: true, publicFigures: ['厉娜', '许飞'], publicFigureContext: '歌手'.repeat(50) })!
    expect(getPublicFigureNames(normal)).toEqual(['厉娜', '许飞'])
    expect(normal.publicFigureContext).toHaveLength(80)
    expect(getPublicFigureContext({ ...plan, prompt: '超级女声歌手，私人地址不要外传' })).toBe('超级女声 歌手')
    expect(getPublicFigureContext({ ...plan, prompt: '私人地址不要外传' })).toBeUndefined()
  })
  test('splits explicit legacy pairs without splitting single names containing 和', () => {
    for (const pair of ['厉娜、许飞', '厉娜/许飞', '厉娜，许飞', '厉娜,许飞', '厉娜与许飞', '厉娜和许飞']) expect(getPublicFigureNames({ publicFigure: pair, publicFigureVisual: true })).toEqual(['厉娜', '许飞'])
    for (const name of ['吴和辉', '张和', '郑和', '和田']) expect(getPublicFigureNames({ publicFigure: name, publicFigureVisual: true })).toEqual([name])
  })
  test('requires independent identities and returns declared person order', () => {
    expect(validatePlanFigureSources(plan)).toEqual([...first, ...second])
    expect(validatePlanFigureSources({ ...plan, publicFigureSources: [...first, second[0]] })).toEqual([])
    expect(validatePlanFigureSources({ ...plan, publicFigureSources: [...first, ...second.map(source => ({ ...source, entityId: 'Q8992471' }))] })).toEqual([])
    expect(validatePlanFigureSources({ ...plan, publicFigureSources: [...first, ...second, source('许飞', 'Q6701420', 3)] })).toEqual([])
    expect(validatePlanFigureSources({ ...plan, publicFigures: undefined, publicFigure: '厉娜、许飞' })).toEqual([...first, ...second])
  })
  test('does not treat names in poster copy as visual people', () => {
    expect(getPublicFigureNames({ publicFigure: '周杰伦', publicFigureVisual: false })).toEqual([])
  })
})


describe('domestic verified source contract', () => {
  const source = (index: number) => ({ provider: 'Sogou/Sina', entityId: 'Q8992471', personName: '厉娜', title: `厉娜演唱 ${index}`, artist: '新浪娱乐', license: '来源页未标注许可，仅作人物参考', imageUrl: `https://www.sinaimg.cn/portrait-${index}.jpg`, thumbUrl: `https://image2.sina.com.cn/thumb-${index}.jpg`, sourceUrl: 'https://slide.ent.sina.com.cn/slide_4_704_1.html?img=1' })
  test('permits distinct images from the same verified gallery', () => {
    expect(validateFigureSources([source(1), source(2)])).toHaveLength(2)
  })
  test('rejects forged hosts, unknown provider, query copies and mixed identities', () => {
    for (const bad of [
      { ...source(2), imageUrl: 'https://www.sinaimg.cn.evil.test/2.jpg' },
      { ...source(2), sourceUrl: 'https://ent.sina.com.cn.evil.test/2.html' },
      { ...source(2), thumbUrl: 'https://image2.sina.com.cn:444/2.jpg' },
      { ...source(2), sourceUrl: 'https://ent.sina.com.cn/2.html#forged' },
      { ...source(2), provider: 'unknown' },
      { ...source(2), imageUrl: `${source(1).imageUrl}?width=240` },
      { ...source(2), entityId: 'Q6701420' },
      { ...source(2), personName: '许飞' },
      { ...source(2), license: 'CC BY' },
    ]) expect(validateFigureSources([source(1), bad])).toEqual([])
  })
})
