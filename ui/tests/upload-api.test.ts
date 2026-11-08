import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fileToDataUrl, imageToDataUrl, request } from '../src/chat/api'
const originals = new Map<string, PropertyDescriptor | undefined>()
function replace(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  originals.clear()
})
function pendingFetch() {
  const fetcher = mock((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason)
    else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  replace('fetch', fetcher)
  return fetcher
}
describe('bounded API requests', () => {
  test('times out and does not claim an unknown submission was free', async () => {
    let expire!: () => void
    replace('setTimeout', (callback: () => void, ms: number) => { expect(ms).toBe(30_000); expire = callback; return 1 })
    const clear = mock(() => {})
    replace('clearTimeout', clear)
    const fetcher = pendingFetch()
    const result = request('generate', { method: 'POST' })
    expire()
    await expect(result).rejects.toMatchObject({ status: 408, message: expect.stringContaining('接单') })
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    expect(clear).toHaveBeenCalled()
  })
  test('forwards external cancellation and cleans up listener', async () => {
    pendingFetch()
    const controller = new AbortController()
    const remove = mock(controller.signal.removeEventListener.bind(controller.signal))
    controller.signal.removeEventListener = remove
    const result = request('history', { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalled()
  })
  test('respects an already aborted signal', async () => {
    pendingFetch()
    await expect(request('history', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
  for (const json of [false, true]) test(`friendly ${json ? 'JSON' : 'HTML'} 413`, async () => {
    replace('fetch', async () => new Response(json ? '{"error":"body too large"}' : '<html>413</html>', { status: 413 }))
    await expect(request('generate')).rejects.toMatchObject({ status: 413, message: expect.stringContaining('图片') })
  })
  test('success keeps JSON contract', async () => {
    replace('fetch', async () => Response.json({ ok: true }))
    expect(await request('bootstrap')).toEqual({ ok: true })
  })
})
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
function reader() {
  replace('createImageBitmap', async () => ({ width: 20, height: 20, close() {} }))
  replace('FileReader', class {
    result = 'data:image/png;base64,test'
    onload?: () => void
    readAsDataURL() { queueMicrotask(() => this.onload?.()) }
  })
}
describe('upload validation', () => {
  test('rejects over 7MB before reading', async () => {
    await expect(fileToDataUrl(new File([new Uint8Array(7 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))).rejects.toThrow('7 MB')
  })
  test('rejects extensions and MIME mismatches', async () => {
    await expect(fileToDataUrl(new File([png], 'image.gif', { type: 'image/png' }))).rejects.toThrow('PNG')
    await expect(fileToDataUrl(new File([png], 'image.jpg', { type: 'image/jpeg' }))).rejects.toThrow('格式')
  })
  test('rejects corrupt pixels despite valid PNG header', async () => {
    replace('createImageBitmap', async () => { throw new Error('decode failed') })
    await expect(fileToDataUrl(new File([png], 'bad.png', { type: 'image/png' }))).rejects.toThrow('损坏')
  })
  test('decodes images and releases bitmap', async () => {
    reader()
    const close = mock(() => {})
    replace('createImageBitmap', async () => ({ width: 20, height: 20, close }))
    expect(await fileToDataUrl(new File([png], 'good.PNG', { type: 'image/png' }))).toStartWith('data:image/')
    expect(close).toHaveBeenCalled()
  })
  test('accepts exactly 7MB and compresses before returning a reference', async () => {
    reader()
    const bytes = new Uint8Array(7 * 1024 * 1024)
    bytes.set(png)
    const file = new File([bytes], 'large.png', { type: 'image/png' })
    const close = mock(() => {})
    replace('createImageBitmap', async () => ({ width: 3000, height: 1500, close }))
    replace('fetch', async () => new Response(file))
    const draw = mock(() => {})
    const encode = mock((callback: (blob: Blob) => void) => callback(new Blob([png], { type: 'image/webp' })))
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toBlob: encode }
    replace('document', { createElement: () => canvas })
    await fileToDataUrl(file)
    expect(canvas.width).toBe(2400)
    expect(canvas.height).toBe(1200)
    expect(encode).toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
describe('same-origin references', () => {
  const job = 'a'.repeat(32), account = 'b'.repeat(64)
  const prefix = 'https://public-assets.example'
  test('maps known originals only', async () => {
    reader()
    const fetcher = mock(async () => new Response(new Blob([png], { type: 'image/png' })))
    replace('fetch', fetcher)
    await imageToDataUrl(`${prefix}/jianlai/results/originals/${account}/${job}-1.png?signature=fixture`)
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/jianlai/api/jobs/${job}/images/1`)
  })
  test('does not map foreign hosts, previews, malformed keys, data or blob', async () => {
    reader()
    const fetcher = mock(async () => new Response(new Blob([png], { type: 'image/png' })))
    replace('fetch', fetcher)
    for (const url of [
      `https://other.example/jianlai/results/originals/${account}/${job}-0.png`,
      `${prefix}/jianlai/results/previews/${account}/${job}-0.webp`,
      `${prefix}/jianlai/results/originals/${account}/not-a-job-0.png`,
      'data:image/png;base64,test', 'blob:fixture',
    ]) {
      await imageToDataUrl(url)
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(url)
    }
  })
  test('keeps Commons proxy routing', async () => {
    reader()
    const fetcher = mock(async () => new Response(new Blob([png], { type: 'image/png' })))
    replace('fetch', fetcher)
    const url = 'https://upload.wikimedia.org/example.jpg'
    await imageToDataUrl(url)
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/jianlai/api/public-image?url=${encodeURIComponent(url)}`)
  })
})

describe('bounded reference image reads', () => {
  test('times out a stalled image request and clears its timer', async () => {
    let expire!: () => void
    replace('setTimeout', (callback: () => void, ms: number) => { expect(ms).toBe(30_000); expire = callback; return 1 })
    const clear = mock(() => {})
    replace('clearTimeout', clear)
    const fetcher = pendingFetch()
    const result = imageToDataUrl('/jianlai/api/jobs/fixture/images/0')
    expire()
    await expect(result).rejects.toMatchObject({ status: 408, message: expect.stringContaining('图片读取超时') })
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    expect(clear).toHaveBeenCalled()
  })
  test('rejects advertised bodies larger than 32MB before reading', async () => {
    replace('fetch', async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(32 * 1024 * 1024 + 1) } }))
    await expect(imageToDataUrl('blob:fixture')).rejects.toThrow('32 MB')
  })
  test('limits streamed bytes even without a content length', async () => {
    replace('fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024)); controller.enqueue(png) },
    }), { headers: { 'content-type': 'image/png' } }))
    await expect(imageToDataUrl('blob:fixture')).rejects.toThrow('32 MB')
  })
  test('rejects failed responses, non-images and corrupt pixels', async () => {
    replace('fetch', async () => new Response('', { status: 403 }))
    await expect(imageToDataUrl('blob:fixture')).rejects.toThrow('无法读取')
    replace('fetch', async () => new Response('<html>bad</html>'))
    await expect(imageToDataUrl('blob:fixture')).rejects.toThrow('格式')
    replace('fetch', async () => new Response(png, { headers: { 'content-type': 'image/png' } }))
    replace('createImageBitmap', async () => { throw new Error('decode failed') })
    await expect(imageToDataUrl('blob:fixture')).rejects.toThrow('损坏')
  })
  test('encodes only compressed bytes for an 8MB original', async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024); bytes.set(png)
    replace('fetch', async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    replace('createImageBitmap', async () => ({ width: 3000, height: 1500, close() {} }))
    const seen: number[] = []
    replace('FileReader', class {
      result = 'data:image/webp;base64,compressed'
      onload?: () => void
      readAsDataURL(blob: Blob) { seen.push(blob.size); queueMicrotask(() => this.onload?.()) }
    })
    replace('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob([png], { type: 'image/webp' })) }) })
    expect(await imageToDataUrl('blob:fixture')).toContain('compressed')
    expect(seen).toEqual([png.length])
  })
})
