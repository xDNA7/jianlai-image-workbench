import type { ApiAnnotation } from './marks'
import type { GalleryRecord, JobImage, Plan, PublicFigureSource, Template } from './types'
import type { components } from '../api/generated'
import { getPublicFigureNames, isPublicFigureImageUrl, validatePlanFigureSources, validateFigureSources } from './public-figures'
export { validateCommonsResult, validateFigureSources } from './public-figures'
import { bootstrapSchema, jobStateSchema, bootstrapResponseSchema, imageJobResponseSchema, historyResponseSchema, templatesResponseSchema, videoJobResponseSchema, videosResponseSchema, chatUsageResponseSchema, type BootstrapContract } from '../schemas/api'

type Wire = components['schemas']
type RawBootstrap = Wire['Bootstrap']
type RawImageJob = Wire['ImageJob']

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function errorMessage(value: unknown, fallback: string): string {
  const message = object(value).error
  return typeof message === 'string' && message.trim() ? message : fallback
}

const assetBase = (import.meta.env.VITE_PUBLIC_ASSET_BASE || (typeof process !== 'undefined' ? process.env.VITE_PUBLIC_ASSET_BASE : '') || 'https://public-assets.example/assets/').replace(/\/?$/, '/')
const ossBase = assetBase.startsWith('/') ? `${assetBase}jianlai/` : `${assetBase}jianlai/`
const ossOrigin = new URL(ossBase, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').origin

export function apiBase(path = typeof window === 'undefined' ? '/' : window.location.pathname) {
  return path === '/jianlai-test' || path.startsWith('/jianlai-test/') ? '/jianlai-test/' : '/jianlai/'
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function withRequestTimeout<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal | null, message = '请求超时，接单状态尚未确认，请先刷新核对任务与额度，勿重复提交'): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(408, message))
      controller.abort()
    }, 30_000)
  })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

export function request(path: 'bootstrap', init?: RequestInit): Promise<RawBootstrap>
export function request<T = unknown>(path: string, init?: RequestInit): Promise<T>
export async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  return withRequestTimeout(async (signal) => {
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await fetch(`${apiBase()}api/${path}`, {
      ...init, credentials: 'same-origin', headers, signal,
    })
    const data: unknown = await response.json().catch((error) => {
      if (signal.aborted) throw error
      return {}
    })
    if (response.status === 413) throw new ApiError(413, '图片提交体积过大，请压缩图片后重试')
    if (!response.ok) throw new ApiError(response.status, errorMessage(data, '请求失败，请稍后重试'))
    return data as T
  }, init.signal)
}

export function assetUrl(value: unknown): string {
  if (!value) return ''
  const s = String(value)
  if (s.startsWith('templates/')) {
    const rest = s.slice('templates/'.length)
    return /\.(?:png|jpe?g|webp)$/i.test(rest)
      ? `${ossBase}templates/previews/${rest.replace(/\.(?:png|jpe?g|webp)$/i, '.webp')}`
      : `${ossBase}${s}`
  }
  return /^(https?:|data:|blob:)/.test(s) ? s : `${apiBase()}${s.replace(/^(?:\.\.\/|\/)+/, '')}`
}

export type Bootstrap = BootstrapContract

const fallbackSizes = [
  { value: 'auto', label: '自动画幅' },
  { value: '1024x1024', label: '1:1 · 方形' },
  { value: '1536x1024', label: '3:2 · 横版' },
  { value: '1024x1536', label: '2:3 · 竖版' },
]
const fallbackQualities = [
  { value: 'auto', label: '自动质量' },
  { value: 'low', label: '标准' },
  { value: 'medium', label: '精细' },
  { value: 'high', label: '高质量' },
]

export async function bootstrap(): Promise<Bootstrap> {
  const v = bootstrapResponseSchema.parse(await request('bootstrap'))
  const caps = v.capabilities
  return bootstrapSchema.parse({
    accountId: String(v.accountId || 'anonymous'),
    availableCents: v.availableCents,
    capabilities: {
      sizes: Array.isArray(caps.sizes) && caps.sizes.length ? caps.sizes : fallbackSizes,
      qualities: Array.isArray(caps.qualities) && caps.qualities.length ? caps.qualities : fallbackQualities,
      priceCents: Number(v.imagePriceCents ?? caps.unitPrice ?? 30),
    },
    activeJobId: v.activeJob?.status === 'running' ? v.activeJob.id : undefined,
    activeRequestKey: v.activeJob?.status === 'running' && typeof v.activeJob.requestKey === 'string' ? v.activeJob.requestKey : undefined,
  })
}

export type SseEvent = { event: string; data: string }

/** Incremental SSE parser; feed decoded text, get complete events. */
export function createSseParser() {
  let buffer = ''
  return (chunk: string): SseEvent[] => {
    buffer += chunk.replace(/\r\n/g, '\n')
    const out: SseEvent[] = []
    let end = buffer.indexOf('\n\n')
    while (end >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) out.push({ event, data: data.join('\n') })
      end = buffer.indexOf('\n\n')
    }
    return out
  }
}

export function normalizePlan(value: unknown): Plan | null {
  const v = object(value)
  const prompt = String(v.prompt || '').trim()
  if (!prompt) return null
  const useReference = Boolean(v.useReference)
  const publicFigure = typeof v.publicFigure === 'string' && v.publicFigure.trim().length <= 120 ? v.publicFigure.trim() : undefined
  const publicFigureVisual = v.publicFigureVisual === true
  const publicFigures = Array.isArray(v.publicFigures) && v.publicFigures.length <= 2 && v.publicFigures.every((name: unknown) => typeof name === 'string' && name.trim() && name.trim().length <= 120) ? v.publicFigures.map((name: unknown) => String(name).trim()) : undefined
  const publicFigureContext = typeof v.publicFigureContext === 'string' ? v.publicFigureContext.trim().slice(0, 80) : undefined
  return {
    prompt,
    text: String(v.text || ''),
    size: String(v.size || 'auto'),
    quality: String(v.quality || 'medium'),
    count: !useReference && Number(v.count) === 2 ? 2 : 1,
    useReference,
    publicFigure,
    publicFigureVisual,
    publicFigures,
    publicFigureContext,
  }
}

export function parseCommonsSearch(payload: unknown): PublicFigureSource[] {
  const pages = object(object(payload).query).pages
  if (!pages || typeof pages !== 'object') return []
  return Object.values(pages).flatMap((value: unknown) => {
    const page = object(value)
    const info = object(Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined)
    const meta = object(info.extmetadata)
    const sourceUrl = String(info.descriptionurl || '')
    const thumbUrl = String(info.thumburl || '')
    const imageUrl = String(info.url || thumbUrl)
    const artist = String(object(meta.Artist).value || '').replace(/<[^>]+>/g, '').trim()
    const license = String(object(meta.LicenseShortName).value || '').replace(/<[^>]+>/g, '').trim()
    if (!page.title || !thumbUrl.startsWith('https://upload.wikimedia.org/') || !imageUrl.startsWith('https://upload.wikimedia.org/') || !sourceUrl.startsWith('https://commons.wikimedia.org/') || !artist || !license) return []
    return [{ title: String(page.title), thumbUrl, imageUrl, sourceUrl, artist, license, licenseUrl: String(object(meta.LicenseUrl).value || '') || undefined }]
  }).slice(0, 6)
}

export async function searchPublicFigure(name: string, signal?: AbortSignal, context?: string): Promise<PublicFigureSource[]> {
  const result = await request<{ name: string; entityId: string; sources: PublicFigureSource[] }>(`public-figure-search?${new URLSearchParams({ name, ...(context?.trim() ? { context: context.trim().slice(0, 80) } : {}) })}`, { signal })
  const sources = validateFigureSources(result.sources)
  if (!sources.length || sources.some(source => source.personName !== name.trim()) || sources[0].entityId !== result.entityId || typeof result.name !== 'string' || result.name.trim() !== name.trim()) throw new Error('没有找到至少两张可确认属于同一人物的图片，请重新搜索或补充更明确的人物姓名')
  return sources.map(source => ({ ...source, personName: name.trim() }))
}

export type ChatHandlers = {
  onMeta?: (used: number, limit: number) => void
  onDelta: (text: string) => void
  onPlan: (plan: Plan) => void
}

export type ChatPayload = {
  messages: { role: 'user' | 'assistant'; content: string }[]
  reference?: { prompt: string }
}

export async function streamChat(payload: ChatPayload, handlers: ChatHandlers, signal?: AbortSignal) {
  const response = await fetch(`${apiBase()}api/chat`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    throw new ApiError(response.status, errorMessage(data, '对话服务暂时不可用'))
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parse = createSseParser()
  for (;;) {
    const { value, done } = await reader.read()
    const events = parse(done ? decoder.decode() : decoder.decode(value, { stream: true }))
    for (const e of events) {
      const data = object(JSON.parse(e.data || '{}'))
      if (e.event === 'meta') handlers.onMeta?.(Number(data.used), Number(data.limit))
      else if (e.event === 'delta') handlers.onDelta(String(data.text || ''))
      else if (e.event === 'plan') {
        const plan = normalizePlan(data)
        if (plan) handlers.onPlan(plan)
      } else if (e.event === 'error') throw new ApiError(502, errorMessage(data, '对话服务暂时不可用'))
      else if (e.event === 'done') return
    }
    if (done) throw new ApiError(502, '对话中断，请重试')
  }
}
export function newRequestKey() {
  return crypto.randomUUID()
}

/** Fetches an image and returns it as a data URL for use as a reference. */
export async function imageToDataUrl(url: string): Promise<string> {
  let sourceUrl = isPublicFigureImageUrl(url) ? `${apiBase()}api/public-image?url=${encodeURIComponent(url)}` : url
  try {
    const parsed = new URL(url)
    const original = parsed.pathname.match(/^\/jianlai\/results\/originals\/[a-f0-9]{64}\/([a-f0-9]{32})-(\d+)\.(?:png|jpe?g|webp)$/)
    if (parsed.origin === ossOrigin && !parsed.username && !parsed.password && original) {
      sourceUrl = `${apiBase()}api/jobs/${original[1]}/images/${original[2]}`
    }
  } catch { /* Relative, data and blob references retain their existing route. */ }
  return withRequestTimeout(async (signal) => {
    const response = await fetch(sourceUrl, { credentials: 'same-origin', signal })
    if (!response.ok) throw new ApiError(response.status, '无法读取上一张图，请重新上传')
    const maxBytes = 32 * 1024 * 1024
    const tooLarge = () => new ApiError(413, '原图超过 32 MB，请下载后缩小再上传')
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel()
      throw tooLarge()
    }
    if (!response.body) throw new Error('图片内容为空，请重新上传')
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel()
          throw tooLarge()
        }
        chunks.push(new Uint8Array(value))
      }
    } finally { reader.releaseLock() }
    signal.throwIfAborted()
    return imageBlobToReference(new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || '' }))
  }, undefined, '图片读取超时，请重试或重新上传参考图')
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

export async function fileToDataUrl(file: File): Promise<string> {
  if (file.size > 7 * 1024 * 1024) throw new Error('图片不能超过 7 MB')
  const extension = file.name.match(/\.(png|jpe?g|webp)$/i)?.[1].toLowerCase()
  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`
  if (!extension || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请上传 PNG、JPEG 或 WebP 图片')
  if (mime !== file.type) throw new Error('图片格式与文件内容不符，请上传有效的 PNG、JPEG 或 WebP 图片')
  return imageBlobToReference(file)
}

async function imageBlobToReference(file: Blob): Promise<string> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const actual = header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71 && header[4] === 13 && header[5] === 10 && header[6] === 26 && header[7] === 10 ? 'image/png'
    : header[0] === 255 && header[1] === 216 && header[2] === 255 ? 'image/jpeg'
      : String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP' ? 'image/webp' : ''
  if (!actual || actual !== file.type) throw new Error('图片格式与文件内容不符，请上传有效的 PNG、JPEG 或 WebP 图片')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
    if (!bitmap.width || !bitmap.height) { bitmap.close(); throw new Error('empty image') }
  } catch { throw new Error('图片已损坏或无法解码，请重新选择图片') }
  try {
    return file.size > 1024 * 1024 || Math.max(bitmap.width, bitmap.height) > 2400
      ? await compressBitmap(bitmap, Math.min(file.size, 4 * 1024 * 1024)) : await blobToDataUrl(file)
  } finally { bitmap.close() }
}

export async function compressImageDataUrl(dataUrl: string, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  // This is the retry after a confirmed 413; shrink even an already compressed upload.
  try { return await compressBitmap(bitmap, Math.min(maxBytes, Math.max(128, Math.floor(blob.size * 0.7)))) } finally { bitmap.close() }
}

async function compressBitmap(bitmap: ImageBitmap, maxBytes: number): Promise<string> {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height))
  let width = Math.max(1, Math.round(bitmap.width * scale))
  let height = Math.max(1, Math.round(bitmap.height * scale))
  for (let sizePass = 0; sizePass < 5; sizePass += 1) {
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法压缩图片，请改用较小的图片')
    context.drawImage(bitmap, 0, 0, width, height)
    for (const quality of [0.88, 0.78, 0.66, 0.54, 0.42]) {
      const compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
      if (compressed && compressed.size <= maxBytes) return blobToDataUrl(compressed)
    }
    width = Math.max(1, Math.round(width * 0.72))
    height = Math.max(1, Math.round(height * 0.72))
  }
  throw new Error('图片压缩后仍超过 4 MB，请选择更小的图片')
}

export type JobState = {
  id: string
  status: 'running' | 'done' | 'failed'
  phase?: string
  error?: string
  chargedCents: number
  availableCents: number | null
  images: JobImage[]
}

export function toJobImages(value: unknown, prompt: string, text = ''): JobImage[] {
  const job = imageJobResponseSchema.parse(value)
  return job.images.map(i => ({
    id: `${job.id}-${i.index}`,
    jobId: job.id,
    index: i.index,
    preview: assetUrl(i.previewUrl || i.url),
    download: assetUrl(i.downloadUrl || i.url),
    prompt,
    text,
  }))
}

export function toJobState(value: unknown, prompt: string, text = ''): JobState {
  const job = imageJobResponseSchema.parse(value)
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    error: job.error || undefined,
    chargedCents: Math.round(job.charged * 100),
    availableCents: job.availableCents ?? null,
    images: toJobImages(job, prompt, text),
  }
}

export type GenerateInput = {
  plan: Plan
  referenceData?: string
  referenceImages?: string[]
  annotations?: ApiAnnotation[]
  requestKey: string
}

export async function submitGenerate({ plan, referenceData, referenceImages, annotations = [], requestKey }: GenerateInput) {
  const references = referenceImages ?? (referenceData ? [referenceData] : [])
  if (references.length > 4) throw new ApiError(400, '最多使用 4 张参考图')
  const edit = references.length > 0
  const names = getPublicFigureNames(plan)
  const sources = validatePlanFigureSources(plan)
  if (names.length && !sources.length) throw new ApiError(400, '请先确认每位人物至少两张不同的参考图')
  if (names.length && references.length !== sources.length + (referenceData ? 1 : 0)) throw new ApiError(400, '人物参考图不完整，请重新确认')
  const mapping = names.map(name => `${sources.flatMap((source, index) => source.personName === name ? [`第${index + (referenceData ? 2 : 1)}张`] : []).join('、')}为${name}的身份参考`).join('；')
  const identity = names.length ? `\n人物身份参考：${referenceData ? '第一张为用户指定的编辑底图，保留其构图与未要求改动的内容；' : ''}${mapping}。分别综合每位人物的面部轮廓、五官比例和年龄特征，保持各自身份一致，不能混淆或合并人物；公开照片只用于人物身份，不照搬其中的服装、姿势、场景、构图或画面文字，仍按用户画面意图和本方案实现。` : ''
  const job = await request<RawImageJob>('generate', {
    method: 'POST',
    body: JSON.stringify({
      prompt: plan.prompt + identity,
      text: plan.text,
      references,
      annotations: edit ? annotations : [],
      mode: edit ? (referenceData ? 'edit' : names.length ? 'blend' : 'edit') : 'reference',
      compare: !edit && plan.count === 2,
      count: edit ? 1 : plan.count,
      size: plan.size,
      quality: plan.quality,
      requestKey,
    }),
  })
  return imageJobResponseSchema.parse(job)
}

export async function getJob(id: string, prompt: string, text = ''): Promise<JobState> {
  return jobStateSchema.parse(toJobState(await request<RawImageJob>(`jobs/${id}`), prompt, text))
}

export async function findJobByRequestKey(requestKey: string, prompt: string, text = ''): Promise<JobState> {
  return jobStateSchema.parse(toJobState(await request<RawImageJob>(`jobs/by-request?requestKey=${encodeURIComponent(requestKey)}`), prompt, text))
}

export async function loadGallery(): Promise<GalleryRecord[]> {
  const v = historyResponseSchema.parse(await request<Wire['History']>('history?limit=100'))
  return v.records.map(r => ({
    id: String(r.id),
    jobId: String(r.jobId),
    index: Number(r.index),
    preview: assetUrl(r.previewUrl || r.image),
    download: assetUrl(r.downloadUrl || r.image),
    prompt: String(r.prompt || ''),
    text: String(r.text || ''),
    created: Number(r.created) || 0,
  }))
}

export async function removeGalleryImage(jobId: string, index: number) {
  await request(`jobs/${jobId}/images/${index}`, { method: 'DELETE' })
}

export async function loadTemplates(): Promise<Template[]> {
  const v = templatesResponseSchema.parse(await request<Wire['Templates']>('templates'))
  return v.templates.map((t, i) => ({
    id: String(t.id || i),
    title: String(t.title || '灵感模板'),
    prompt: String(t.prompt || t.description || t.title || '').replace(
      /\{\{([^}]+)\}\}/g,
      (_: string, key: string) => (t.parameterDefaults || {})[key.trim()] || key.trim(),
    ),
    text: String(t.text || ''),
    size: t.size ? String(t.size) : undefined,
    preview: assetUrl(t.preview),
    category: t.category ? String(t.category) : undefined,
  }))
}

export type VideoJob = Wire['VideoJob']

export async function loadVideos(): Promise<VideoJob[]> {
  return videosResponseSchema.parse(await request<Wire['Videos']>('videos')).records
}

export async function getVideo(id: string): Promise<VideoJob> {
  return videoJobResponseSchema.parse(await request<VideoJob>(`videos/${encodeURIComponent(id)}`))
}

export async function getVideoByRequest(key: string): Promise<VideoJob> {
  return videoJobResponseSchema.parse(await request<VideoJob>(`videos/by-request?requestKey=${encodeURIComponent(key)}`))
}

export async function chatUsage(): Promise<{ used: number; limit: number }> {
  return chatUsageResponseSchema.parse(await request<Wire['ChatUsage']>('chat'))
}
