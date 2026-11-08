import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { VideoStudio } from './VideoStudio'
import { ApiError, getVideo, loadVideos, request, type VideoJob } from './api'
import { videoFormSchema, type VideoFormValues } from './schemas'
import { clearPendingVideo, readPendingVideo, videoPayloadHash, writePendingVideo, type PendingVideo, type VideoPayload } from './video-pending'

type Props = {
  accountId: string | null
  balance: number | null
  onBalance: (cents?: number | null) => void
}
const unresolved = '上次视频提交结果尚未确认，请先核对；相同输入重试会沿用原请求，不会创建重复任务'
const messageOf = (error: unknown) => error instanceof Error ? error.message : '视频任务提交失败'

/** Owns paid video requests, recovery and API data within one account boundary. */
export default function VideoPane({ accountId, balance, onBalance }: Props) {
  const [job, setJob] = useState<VideoJob | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [hasPending, setHasPending] = useState(false)
  const pending = useRef<PendingVideo | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  const balanceCallback = useRef(onBalance)
  balanceCallback.current = onBalance
  const form = useForm<VideoFormValues>({
    defaultValues: { prompt: '', image: null, seconds: 5, ratio: '16:9', resolution: '768P' },
  })
  const values = form.watch()
  const queryClient = useQueryClient()
  const recordsKey = ['videos', accountId]
  const recordsQuery = useQuery({ queryKey: recordsKey, queryFn: loadVideos, enabled: Boolean(accountId), retry: 1 })
  const activeQuery = useQuery({
    queryKey: ['video-job', accountId, job?.id],
    queryFn: () => {
      if (!job) throw new Error('没有可查询的视频任务')
      return getVideo(job.id)
    },
    enabled: Boolean(accountId && job?.id && !['done', 'failed'].includes(job.status)),
    refetchInterval: query => {
      const status = query.state.data?.status ?? job?.status
      return status && !['done', 'failed'].includes(status) ? 10_000 : false
    },
    retry: 1,
  })
  const clearPending = useCallback(() => {
    if (!accountId) return
    try { clearPendingVideo(accountId) } catch { /* The server result is already authoritative. */ }
    pending.current = null
    setHasPending(false)
  }, [accountId])
  const accept = useCallback((value: VideoJob) => {
    if (!alive.current) return
    clearPending()
    setJob(value)
    const terminal = ['done', 'failed'].includes(value.status)
    setBusy(!terminal)
    setError(value.status === 'failed' ? value.error || '视频任务失败，额度已退回' : '')
    balanceCallback.current(value.availableCents)
    if (terminal) void queryClient.invalidateQueries({ queryKey: ['videos', accountId], exact: true })
  }, [accountId, clearPending, queryClient])
  // null is a confirmed 404. Other failures must never authorize a new POST.
  const findPending = useCallback(async (value: PendingVideo) => {
    try {
      return await request<VideoJob>(`videos/by-request?requestKey=${encodeURIComponent(value.key)}`)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) return null
      throw reason
    }
  }, [])

  useEffect(() => {
    alive.current = true
    if (!accountId) { setBusy(true); return () => { alive.current = false } }
    let cancelled = false
    locked.current = true
    const restore = async () => {
      const saved = readPendingVideo(accountId)
      pending.current = saved
      setHasPending(Boolean(saved))
      let found: VideoJob | null = null
      let lookupFailed = false
      if (saved) {
        try { found = await findPending(saved) } catch { lookupFailed = true }
      }
      if (cancelled) return
      if (found) { accept(found); return }
      // Bootstrap follows pending-key reconciliation. It can recover another
      // already-active task, but cannot prove an unknown POST was rejected.
      try {
        const boot = await request('bootstrap')
        if (cancelled) return
        if (boot.accountId !== accountId) { setError('账户已变更，请刷新页面后继续'); return }
        if (!saved && boot.activeVideo) { accept(boot.activeVideo); return }
      } catch { /* A pending key remains available for an explicit retry. */ }
      if (!cancelled) {
        setBusy(false)
        if (saved) setError(lookupFailed ? `${unresolved}（核对暂时失败）` : unresolved)
      }
    }
    void restore().finally(() => { if (!cancelled) locked.current = false })
    return () => { cancelled = true; alive.current = false }
  }, [accountId, accept, findPending])

  useEffect(() => {
    if (activeQuery.data) accept(activeQuery.data)
  }, [activeQuery.data, accept])
  useEffect(() => {
    if (activeQuery.isError) setError('状态暂时无法读取，任务仍会在服务端继续；稍后再试')
  }, [activeQuery.isError])

  const checkPending = async () => {
    if (!accountId || locked.current || !pending.current) return
    locked.current = true
    setBusy(true)
    try {
      const found = await findPending(pending.current)
      if (!alive.current) return
      if (found) accept(found)
      else { setBusy(false); setError('尚未找到上次任务。请保持原输入重试；系统会复用原请求编号') }
    } catch {
      if (alive.current) { setBusy(false); setError(`${unresolved}（核对暂时失败）`) }
    } finally { locked.current = false }
  }
  const submit = async (payload: VideoPayload) => {
    if (!accountId || locked.current || job && !['done', 'failed'].includes(job.status)) return
    locked.current = true
    setBusy(true)
    setError('')
    let sent = false
    try {
      const hash = await videoPayloadHash(payload)
      if (!alive.current) return
      let value = pending.current
      if (value) {
        const found = await findPending(value)
        if (!alive.current) return
        if (found) { accept(found); return }
        if (value.hash !== hash) { setBusy(false); setError('上次提交结果尚未确认，不能更换输入再次提交。请先核对上次提交'); return }
      } else {
        value = { key: crypto.randomUUID(), hash }
        // Persist before sending. If storage is unavailable, no paid request
        // starts because a refresh would otherwise lose its idempotency key.
        writePendingVideo(accountId, value)
        pending.current = value
        setHasPending(true)
      }
      sent = true
      const accepted = await request<VideoJob>('videos', { method: 'POST', body: JSON.stringify({ requestKey: value.key, ...payload }) })
      if (alive.current) accept(accepted)
    } catch (reason) {
      if (!alive.current) return
      const rejected = sent && reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408
      if (rejected) {
        clearPending()
        setBusy(false)
        setError(messageOf(reason))
        balanceCallback.current()
      } else if (pending.current) {
        // A transport error can happen after the server accepted and charged.
        // Reconcile by the saved key before offering any resubmission.
        try {
          const found = await findPending(pending.current)
          if (!alive.current) return
          if (found) { accept(found); return }
        } catch { /* Keep the same key and block any changed-payload POST. */ }
        if (alive.current) { setBusy(false); setError(unresolved) }
      } else {
        setBusy(false)
        setError(`无法安全保存视频请求，请启用此页面的会话存储后重试：${messageOf(reason)}`)
      }
    } finally { locked.current = false }
  }

  const setField = <K extends keyof VideoFormValues>(key: K, value: VideoFormValues[K]) => {
    const next = { ...form.getValues(), [key]: value }
    if (!videoFormSchema.safeParse(next).success) return
    form.setValue(key, value as never, { shouldDirty: true, shouldValidate: true })
  }
  return (
    <div className="studio-shell mx-auto w-full max-w-5xl px-4 pb-10">
      <VideoStudio
        quota={balance} videoRecords={recordsQuery.data || []} videoJob={job}
        videoPrompt={values.prompt} setVideoPrompt={value => setField('prompt', value)}
        videoImage={values.image} setVideoImage={value => setField('image', value)}
        videoSeconds={values.seconds} setVideoSeconds={value => setField('seconds', value)}
        videoRatio={values.ratio} setVideoRatio={value => setField('ratio', value as VideoFormValues['ratio'])}
        videoResolution={values.resolution} setVideoResolution={value => setField('resolution', value as VideoFormValues['resolution'])}
        videoBusy={busy} videoError={error} setVideoError={setError}
        submitVideo={submit} pendingVideo={hasPending} checkPendingVideo={checkPending}
        loadVideos={() => queryClient.invalidateQueries({ queryKey: ['videos', accountId], exact: true })}
      />
    </div>
  )
}
