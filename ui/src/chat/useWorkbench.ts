import { getPublicFigureContext, getPublicFigureNames, validatePlanFigureSources } from './public-figures'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError, bootstrap, chatUsage, fileToDataUrl, getJob, imageToDataUrl, loadGallery, loadTemplates,
  newRequestKey, removeGalleryImage, streamChat, submitGenerate, compressImageDataUrl,
  findJobByRequestKey, searchPublicFigure,
} from './api'
import {
  clearThread, loadFavorites, loadPrivateTemplates, loadThread, makePrivateTemplate, saveFavorites,
  savePrivateTemplates, saveThread, toChatMessages, toggleFavoriteKeys,
} from './store'
import type { FavoriteTarget } from './store'
import { referencePromptWithMarks, toApiAnnotations } from './marks'
import type { Mark } from './marks'
import type {
  AssistantItem, GalleryRecord, JobItem, Plan, Reference, Template, ThreadItem, UserItem,
} from './types'

const POLL_MS = 1500
const POLL_LIMIT_MS = 13 * 60_000
const uid = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)
const noStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const storage = () => (typeof window === 'undefined' ? noStorage : window.localStorage)

export type Upload = { id: string; name: string; dataUrl: string }

export function defaultPlan(text: string, useReference: boolean): Plan {
  return { prompt: text, text: '', size: 'auto', quality: 'medium', count: 1, useReference }
}

export function isActiveJob(item: ThreadItem) {
  return item.type === 'job' && (item.status === 'submitting' || item.status === 'running')
}

export function clearJobQueryError<T extends JobItem>(item: T, status: 'running' | 'done') {
  const { error: _error, ...rest } = item
  return { ...rest, status } as T
}

export function useWorkbench() {
  const queryClient = useQueryClient()
  const [items, setItems] = useState<ThreadItem[]>([])
  const [replying, setReplying] = useState(false)
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites(storage()))
  const [pinned, setPinned] = useState<{ url: string; preview: string; prompt: string; marks: Mark[] } | null>(null)
  const [templatesRequested, setTemplatesRequested] = useState(false)
  const [mine, setMine] = useState<Template[]>(() => loadPrivateTemplates(storage()))
  const itemsRef = useRef(items)
  itemsRef.current = items
  const uploads = useRef(new Map<string, string>())
  const abort = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const polling = useRef(new Set<string>())
  const stopped = useRef(new Set<string>())
  const submitting = useRef(false)
  const loadedAccount = useRef<string | null>(null)
  const bootQuery = useQuery({
    queryKey: ['bootstrap'],
    queryFn: bootstrap,
    retry: 1,
  })
  const boot = bootQuery.data ?? null
  const accountId = boot?.accountId ?? null
  const balance = boot?.availableCents ?? null
  const usageQuery = useQuery({
    queryKey: ['chat', 'usage', accountId],
    queryFn: chatUsage,
    enabled: Boolean(boot),
    initialData: { used: 0, limit: 50 },
    staleTime: 30_000,
    retry: 1,
  })
  const usage = usageQuery.data
  const bootError = bootQuery.error ? messageOf(bootQuery.error, '无法连接服务，请刷新重试') : ''
  const ready = Boolean(boot)
  const galleryQuery = useQuery({
    queryKey: ['history', 'gallery', accountId],
    queryFn: loadGallery,
    enabled: ready,
    retry: 1,
  })
  const templatesQuery = useQuery({
    queryKey: ['templates', accountId],
    queryFn: loadTemplates,
    enabled: ready && templatesRequested,
    retry: 1,
  })
  const gallery = galleryQuery.data ?? []
  const galleryState: 'loading' | 'ready' | 'error' = galleryQuery.isError ? 'error' : galleryQuery.data ? 'ready' : 'loading'
  const templates = templatesQuery.data ?? []
  const templatesState: 'idle' | 'loading' | 'ready' | 'error' = templatesQuery.isFetching ? 'loading' : templatesQuery.isError ? 'error' : templatesQuery.isSuccess ? 'ready' : 'idle'
  const setBalance = useCallback((availableCents: number) => {
    if (!accountId || !Number.isFinite(availableCents)) return
    // A delayed job response must never change the next account's balance.
    if (queryClient.getQueryData<typeof boot>(['bootstrap'])?.accountId !== accountId) return
    void queryClient.cancelQueries({ queryKey: ['bootstrap'] })
    queryClient.setQueryData<typeof boot>(['bootstrap'], (current) => current?.accountId === accountId
      ? { ...current, availableCents } : current)
  }, [accountId, queryClient])
  const patch = useCallback(<T extends ThreadItem>(id: string, fn: (item: T) => T) => {
    setItems((prev) => prev.map((i) => (i.id === id ? fn(i as T) : i)))
  }, [])
  const refreshGallery = useCallback(async () => {
    if (!accountId) return
    await queryClient.refetchQueries({ queryKey: ['history', 'gallery', accountId], exact: true })
  }, [accountId, queryClient])

  useEffect(() => {
    if (!boot) return
    if (loadedAccount.current === boot.accountId) return
    loadedAccount.current = boot.accountId
    const restored = loadThread(boot.accountId, storage())
    const activeId = boot.activeJobId
    const unresolved = restored.filter((item): item is JobItem => item.type === 'job' && !item.jobId && (item.status === 'unknown' || (item.status === 'failed' && item.phase !== 'failed')))
    const candidate = unresolved.find((item) => item.requestKey === boot.activeRequestKey)
    setItems(activeId && candidate && !restored.some((item) => item.type === 'job' && item.jobId === activeId)
      ? restored.map((item) => item.id === candidate.id ? { ...candidate, jobId: activeId, status: 'running', error: undefined } : item)
      : restored)
  }, [boot])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      abort.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!ready || !boot) return
    const streaming = items.some(
      (i) => (i.type === 'assistant' && i.status === 'streaming') || (i.type === 'job' && i.status === 'submitting'),
    )
    if (!streaming) {
      saveThread(boot.accountId, items, storage())
      return
    }
    const timer = setTimeout(() => saveThread(boot.accountId, items, storage()), 400)
    return () => clearTimeout(timer)
  }, [items, ready, boot])

  useEffect(() => {
    if (!ready || !boot) return
    const flush = () => saveThread(boot.accountId, itemsRef.current, storage())
    const onVisibility = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ready, boot])

  const ensureTemplates = useCallback(async () => {
    if (!templatesRequested) {
      setTemplatesRequested(true)
      return
    }
    if (!accountId || templatesQuery.isFetching || templatesQuery.isSuccess) return
    await templatesQuery.refetch()
  }, [accountId, templatesRequested, templatesQuery])

  const toggleFavorite = useCallback((target: FavoriteTarget) => {
    setFavorites((prev) => {
      const next = toggleFavoriteKeys(prev, target)
      saveFavorites(next, storage())
      return next
    })
  }, [])

  const saveMine = useCallback((title: string, image: { prompt: string; text?: string; preview: string; download: string }) => {
    setMine((prev) => {
      const next = [makePrivateTemplate(title, image), ...prev]
      savePrivateTemplates(next, storage())
      return next
    })
  }, [])

  const removeMine = useCallback((id: string) => {
    setMine((prev) => {
      const next = prev.filter((t) => t.id !== id)
      savePrivateTemplates(next, storage())
      return next
    })
  }, [])

  const deleteImage = useCallback(async (record: { jobId: string; index: number }) => {
    if (!accountId) return
    await removeGalleryImage(record.jobId, record.index)
    const queryKey = ['history', 'gallery', accountId]
    await queryClient.cancelQueries({ queryKey, exact: true })
    queryClient.setQueryData<GalleryRecord[]>(queryKey, (current) => current?.filter((r) => !(r.jobId === record.jobId && r.index === record.index)))
    await queryClient.invalidateQueries({ queryKey, exact: true })
  }, [accountId, queryClient])
  const pollJob = useCallback(async (itemId: string, jobId: string, prompt: string, text: string) => {
    if (polling.current.has(jobId)) return
    polling.current.add(jobId)
    const deadline = Date.now() + POLL_LIMIT_MS
    try {
      while (alive.current && !stopped.current.has(itemId)) {
        if (Date.now() > deadline) {
          patch<JobItem>(itemId, (i) => ({ ...i, status: 'unknown', error: '等待超时，任务可能仍在生成，请继续查询或到画廊核对费用' }))
          return
        }
        try {
          const state = await queryClient.fetchQuery({
            queryKey: ['jobs', jobId],
            queryFn: () => getJob(jobId, prompt, text),
            staleTime: 0,
          })
          if (state.availableCents != null) setBalance(state.availableCents)
          if (state.status === 'done') {
            patch<JobItem>(itemId, (i) => ({
              ...clearJobQueryError(i, 'done'), images: state.images, chargedCents: state.chargedCents, phase: 'done', error: state.error,
            }))
            await queryClient.invalidateQueries({ queryKey: ['history', 'gallery', accountId], exact: true })
            return
          }
          if (state.status === 'failed') {
            patch<JobItem>(itemId, (i) => ({ ...i, status: 'failed', error: state.error || '生成失败', chargedCents: state.chargedCents, phase: 'failed' }))
            return
          }
          if (stopped.current.has(itemId)) return
          patch<JobItem>(itemId, (i) => ({ ...clearJobQueryError(i, 'running'), phase: state.phase }))
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            patch<JobItem>(itemId, (i) => ({ ...i, status: 'unknown', error: '任务已不存在，费用状态未知，请到画廊或账户记录核对' }))
            return
          }
          if (e instanceof ApiError) patch<JobItem>(itemId, (i) => ({ ...i, error: `查询任务失败：${e.message}。生成状态未知，可继续查询或先到画廊确认` }))
        }
        await sleep(POLL_MS)
      }
    } finally {
      polling.current.delete(jobId)
    }
  }, [accountId, patch, queryClient, setBalance])

  const startJob = useCallback(async (plan: Plan, reference?: Reference, previous?: JobItem) => {
    if (submitting.current || itemsRef.current.some(isActiveJob)) return
    submitting.current = true
    const itemId = previous?.id ?? uid()
    const wasUnknown = previous?.status === 'unknown'
    let requestKey = previous?.status === 'unknown' ? previous.requestKey : newRequestKey()
    stopped.current.delete(itemId)
    const job: JobItem = {
      type: 'job', id: itemId, requestKey, plan, reference, status: 'submitting',
      images: [], started: Date.now(), created: Date.now(),
    }
    setItems((prev) => previous ? prev.map((item) => item.id === itemId ? job : item) : [...prev, job])
    let rejected = false
    let submitted = false
    try {
      if (wasUnknown && validatePlanFigureSources(plan).some(source => source.provider === 'Sogou/Sina')) {
        try {
          const recovered = await findJobByRequestKey(requestKey, plan.prompt, plan.text)
          if (stopped.current.has(itemId) || !alive.current) return
          patch<JobItem>(itemId, (i) => ({ ...i, jobId: recovered.id, status: 'running', phase: recovered.phase }))
          void pollJob(itemId, recovered.id, plan.prompt, plan.text)
          return
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error
        }
      }
      let referenceData: string | undefined
      if (plan.useReference && reference) {
        referenceData = reference.kind === 'upload'
          ? uploads.current.get(reference.id)
          : await imageToDataUrl(reference.url)
        if (!referenceData) throw new Error('参考图已失效，请重新上传')
      }
      const sources = validatePlanFigureSources(plan)
      if (getPublicFigureNames(plan).length && !sources.length) throw new Error('需要至少两张确认属于同一人物的参考图，请重新搜索人物图片')
      if (sources.length + (referenceData ? 1 : 0) > 4) throw new Error('最多使用 4 张参考图，双人各需两张，请关闭上传底图参考')
      if (previous && sources.some(source => source.provider === 'Sogou/Sina')) {
        const renewed = (await Promise.all(getPublicFigureNames(plan).map(name => searchPublicFigure(name, undefined, getPublicFigureContext(plan))))).flat()
        if (sources.some(source => !renewed.some(found => found.entityId === source.entityId && found.personName === source.personName && found.imageUrl === source.imageUrl))) {
          throw new Error('原人物参考图已失效，请重新发起方案并核对参考；本次未重新提交生成')
        }
      }
      if (stopped.current.has(itemId) || !alive.current) return
      const identityImages = await Promise.all(sources.map((source) => imageToDataUrl(source.imageUrl)))
      if (new Set(identityImages).size !== identityImages.length) throw new Error('人物参考图片重复，请重新搜索至少两张不同照片')
      const referenceImages = referenceData ? [referenceData, ...identityImages] : identityImages
      if (referenceImages.length > 4) throw new Error('最多使用 4 张参考图，请减少人物参考图片')
      const annotations = referenceData && reference && reference.kind !== 'upload' ? toApiAnnotations(reference.marks ?? []) : []
      if (stopped.current.has(itemId) || !alive.current) return
      let created
      try {
        submitted = true
        created = await submitGenerate({ plan, referenceData, referenceImages, annotations, requestKey })
      } catch (error) {
        rejected = error instanceof ApiError && [400, 401, 402, 403, 413, 422, 429].includes(error.status)
        if (error instanceof ApiError && error.status === 413 && referenceImages.length && !wasUnknown) {
          submitted = false
          const compressed = await Promise.all(referenceImages.map((image) => compressImageDataUrl(image)))
          if (stopped.current.has(itemId) || !alive.current) return
          requestKey = newRequestKey()
          patch<JobItem>(itemId, (i) => ({ ...i, requestKey }))
          rejected = false
          submitted = true
          created = await submitGenerate({ plan, referenceData: referenceData ? compressed[0] : undefined, referenceImages: compressed, annotations, requestKey })
        } else throw error
      }
      patch<JobItem>(itemId, (i) => ({ ...i, jobId: created.id, status: stopped.current.has(itemId) ? 'unknown' : 'running', phase: created.phase }))
      void pollJob(itemId, created.id, plan.prompt, plan.text)
    } catch (e) {
      const denied = !wasUnknown && (!submitted || rejected || (e instanceof ApiError && [400, 401, 402, 403, 413, 422, 429].includes(e.status)))
      const error = wasUnknown
        ? `原请求结果仍未知，费用待核对；将保留原请求继续查询：${messageOf(e, '请先到画廊核对')}`
        : !submitted ? `未提交，未扣费：${messageOf(e, '无法读取参考图，请重新搜索或上传')}` : messageOf(e, '提交结果未知，请先核对画廊；按原请求继续提交不会重复创建任务')
      patch<JobItem>(itemId, (i) => ({ ...i, status: denied ? 'failed' : 'unknown', phase: denied ? 'failed' : undefined, chargedCents: denied ? 0 : undefined, error }))
    } finally {
      submitting.current = false
    }
  }, [patch, pollJob])

  useEffect(() => {
    if (!ready) return
    for (const item of itemsRef.current) {
      if (item.type === 'job' && item.status === 'running' && item.jobId) {
        void pollJob(item.id, item.jobId, item.plan.prompt, item.plan.text)
      }
    }
  }, [ready, pollJob, items])

  const stopWaiting = useCallback((itemId: string) => {
    stopped.current.add(itemId)
    patch<JobItem>(itemId, (i) => ({
      ...i, status: 'unknown', error: '已停止等待，尚未取消服务端任务。最终结果和费用待确认，请继续查询或到画廊核对',
    }))
  }, [patch])
  const retryPolling = useCallback((itemId: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === itemId)
    if (item?.type !== 'job') return
    if (!item.jobId) return
    stopped.current.delete(itemId)
    patch<JobItem>(itemId, (current) => ({ ...current, status: 'running', error: undefined }))
    void pollJob(item.id, item.jobId, item.plan.prompt, item.plan.text)
  }, [patch, pollJob])
  const retryGeneration = useCallback(async (itemId: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === itemId)
    if (item?.type !== 'job' || submitting.current || itemsRef.current.some(isActiveJob)) return
    if (!item.jobId) {
      await startJob(item.plan, item.reference, item)
      return
    }
    submitting.current = true
    try {
      const state = await getJob(item.jobId, item.plan.prompt, item.plan.text)
      if (state.availableCents != null) setBalance(state.availableCents)
      if (state.status !== 'failed') {
        const status = state.status
        patch<JobItem>(itemId, (current) => ({ ...clearJobQueryError(current, status), images: state.images, chargedCents: state.chargedCents, error: state.error, phase: state.phase }))
        if (state.status === 'running') {
          stopped.current.delete(itemId)
          void pollJob(itemId, item.jobId, item.plan.prompt, item.plan.text)
        }
        return
      }
      patch<JobItem>(itemId, (current) => ({ ...current, status: 'failed', phase: 'failed', error: state.error, chargedCents: state.chargedCents }))
      submitting.current = false
      await startJob(item.plan, item.reference)
    } catch (e) {
      patch<JobItem>(itemId, (current) => ({ ...current, status: 'unknown', error: `无法确认原任务状态，未创建新任务：${messageOf(e, '查询失败')}` }))
    } finally {
      submitting.current = false
    }
  }, [patch, pollJob, setBalance, startJob])
  const send = useCallback(async (text: string, upload?: Upload) => {
    const clean = text.trim()
    if (!clean || replying) return
    let reference: Reference | undefined
    if (upload) {
      uploads.current.set(upload.id, upload.dataUrl)
      reference = { kind: 'upload', id: upload.id, name: upload.name, preview: upload.dataUrl }
    } else if (pinned) {
      // A reference exists only when the user uploaded one or picked an image to edit.
      reference = { kind: 'picked', url: pinned.url, preview: pinned.preview, prompt: pinned.prompt, marks: pinned.marks }
    }
    const created = Date.now()
    const userItem: UserItem = { type: 'user', id: uid(), text: clean, reference: upload ? reference : undefined, created }
    const replyItem: AssistantItem = {
      type: 'assistant', id: uid(), text: '', status: 'streaming', source: clean, reference, created,
    }
    const history = [...itemsRef.current, userItem]
    setItems([...history, replyItem])
    setPinned(null)
    setReplying(true)
    const controller = new AbortController()
    abort.current = controller
    try {
      await streamChat(
        {
          messages: toChatMessages(history),
          reference: reference
            ? { prompt: reference.kind === 'upload' ? '用户本次新上传的参考照片。仅以本次上传图片为准，不沿用此前生成图片、人物或场景。' : referencePromptWithMarks(reference.prompt ?? '', reference.marks) }
            : undefined,
        },
        {
          onMeta: (used, limit) => queryClient.setQueryData(['chat', 'usage', accountId], { used, limit }),
          onDelta: (delta) => patch<AssistantItem>(replyItem.id, (i) => ({ ...i, text: i.text + delta })),
          onPlan: (plan) => patch<AssistantItem>(replyItem.id, (i) => ({
            ...i,
            planState: 'open',
            plan: reference && plan.useReference ? { ...plan, count: 1 } : { ...plan, useReference: false },
          })),
        },
        controller.signal,
      )
      patch<AssistantItem>(replyItem.id, (i) => ({ ...i, status: 'done' }))
    } catch (e) {
      const stoppedByUser = e instanceof DOMException && e.name === 'AbortError'
      if (e instanceof ApiError && e.status === 429) {
        queryClient.setQueryData<{ used: number; limit: number }>(['chat', 'usage', accountId], (current) => ({
          used: current?.limit ?? usage.limit,
          limit: current?.limit ?? usage.limit,
        }))
      }
      patch<AssistantItem>(replyItem.id, (i) => stoppedByUser
        ? { ...i, status: i.text ? 'done' : 'error', error: i.text ? undefined : '已停止' }
        : { ...i, status: 'error', error: messageOf(e, '对话服务暂时不可用') })
    } finally {
      if (abort.current === controller) {
        abort.current = null
        setReplying(false)
      }
    }
  }, [accountId, patch, queryClient, replying, pinned, usage.limit])
  const stopReplying = useCallback(() => abort.current?.abort(), [])

  const updatePlan = useCallback((id: string, next: Plan) => {
    patch<AssistantItem>(id, (i) => ({ ...i, plan: next }))
  }, [patch])

  const rebindReference = useCallback(async (id: string, file: File) => {
    const dataUrl = await fileToDataUrl(file)
    const item = itemsRef.current.find((candidate) => candidate.id === id)
    if ((item?.type !== 'assistant' && item?.type !== 'job') || item.reference?.kind !== 'upload') return
    const referenceId = item.reference.id
    uploads.current.set(referenceId, dataUrl)
    setItems((prev) => prev.map((candidate) => 'reference' in candidate && candidate.reference?.kind === 'upload' && candidate.reference.id === referenceId
      ? { ...candidate, reference: { ...candidate.reference, name: file.name, preview: dataUrl } } : candidate))
  }, [])

  const uploadPersonReference = useCallback(async (id: string, file: File) => {
    const dataUrl = await fileToDataUrl(file)
    const item = itemsRef.current.find((candidate) => candidate.id === id)
    if (item?.type !== 'assistant' || !item.plan || item.planState !== 'open') return
    const reference: Reference = { kind: 'upload', id: uid(), name: file.name, preview: dataUrl }
    uploads.current.set(reference.id, dataUrl)
    const plan: Plan = { ...item.plan, publicFigureVisual: false, publicFigure: undefined, publicFigures: [], publicFigureContext: undefined, publicFigureSource: undefined, publicFigureSources: [], useReference: true, count: 1 }
    patch<AssistantItem>(id, (current) => ({ ...current, plan, reference }))
  }, [patch])

  const dismissPlan = useCallback((id: string) => {
    patch<AssistantItem>(id, (i) => ({ ...i, planState: 'dismissed' }))
  }, [patch])

  const confirmPlan = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id)
    if (!item || item.type !== 'assistant' || !item.plan || item.planState !== 'open') return
    if (submitting.current || itemsRef.current.some(isActiveJob)) return
    if (item.plan.useReference && item.reference?.kind === 'upload' && !uploads.current.has(item.reference.id)) return
    if (getPublicFigureNames(item.plan).length && (!validatePlanFigureSources(item.plan).length || (item.plan.publicFigureSources?.length ?? 0) + (item.plan.useReference && item.reference ? 1 : 0) > 4)) return
    patch<AssistantItem>(id, (i) => ({ ...i, planState: 'submitted' }))
    void startJob(item.plan, item.plan.useReference ? item.reference : undefined)
  }, [patch, startJob])

  const generateAsWritten = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id)
    if (!item || item.type !== 'assistant' || item.plan || item.status !== 'error') return
    if (submitting.current || itemsRef.current.some(isActiveJob)) return
    const reference = item.reference
    const plan = defaultPlan(item.source, Boolean(reference))
    patch<AssistantItem>(id, (i) => ({ ...i, plan, planState: 'submitted' }))
    void startJob(plan, reference)
  }, [patch, startJob])

  const clearAll = useCallback(() => {
    const controller = abort.current
    abort.current = null
    controller?.abort()
    setReplying(false)
    setPinned(null)
    for (const item of itemsRef.current) if (item.type === 'job') stopped.current.add(item.id)
    uploads.current.clear()
    setItems([])
    if (boot) clearThread(boot.accountId, storage())
  }, [boot])

  const pin = useCallback((r: { download: string; preview: string; prompt: string }, marks: Mark[] = []) => {
    setPinned({ url: r.download, preview: r.preview, prompt: r.prompt, marks })
  }, [])
  const unpin = useCallback(() => setPinned(null), [])

  const refreshBalance = useCallback((cents?: number | null) => {
    if (typeof cents === 'number' && Number.isFinite(cents)) setBalance(cents)
    else void queryClient.invalidateQueries({ queryKey: ['bootstrap'], exact: true })
  }, [queryClient, setBalance])

  const busy = items.some(isActiveJob)
  const price = boot?.capabilities.priceCents ?? 30
  return {
    boot, bootError, ready, items, balance, usage, replying, busy, price,
    gallery, galleryState, favorites, templates, templatesState, mine, saveMine, removeMine,
    send, stopReplying, updatePlan, rebindReference, uploadPersonReference, dismissPlan, confirmPlan, generateAsWritten,
    refreshBalance, pinned, pin, unpin, stopWaiting, retryPolling, retryGeneration, clearAll, refreshGallery, toggleFavorite, deleteImage, ensureTemplates,
  }
}
