import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, XIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import avatar from '../assets/assistant-avatar.webp'
import { Composer } from './Composer'
import { chatUsage, type VideoJob } from './api'
import type { VideoPayload } from './video-pending'
import type { Upload } from './useWorkbench'
import { streamVideoChat, type VideoMessage } from './video-chat'
import { compileStoryboard, duplicateStoryboardShot, moveStoryboardShot, normalizeStoryboard, removeStoryboardShot, resizeStoryboard, type VideoStoryboard } from './video-storyboard'
import './video-conversation.css'

type Turn = { id: string; user: string; text: string; status: 'streaming' | 'ready' | 'error' | 'stopped'; storyboard?: VideoStoryboard; error?: string; confirmed?: boolean }
type Props = {
  accountId: string | null
  quota: number | null
  videoJob: VideoJob | null
  videoBusy: boolean
  videoError: string
  submitVideo: (payload: VideoPayload) => Promise<void>
  pendingVideo: boolean
  checkPendingVideo: () => Promise<void>
  retryJob: () => void
}
const draftKey = (account: string) => `jianlai:video-conversation:${encodeURIComponent(account)}`
const msg = (reason: unknown) => reason instanceof Error ? reason.message : '分镜暂时无法整理，请重试'
const cost = (duration: number) => `¥${(duration * 1.2).toFixed(2)}`
function restoreTurns(accountId: string | null): Turn[] {
  if (!accountId) return []
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(draftKey(accountId)) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.slice(-12).flatMap((value: unknown) => {
      if (!value || typeof value !== 'object' || !('user' in value) || typeof value.user !== 'string' || !('text' in value) || typeof value.text !== 'string') return []
      const storyboard = 'storyboard' in value ? normalizeStoryboard(value.storyboard) || undefined : undefined
      return [{ id: crypto.randomUUID(), user: value.user.slice(0, 2000), text: value.text.slice(0, 6000), status: 'ready' as const, storyboard, confirmed: 'confirmed' in value && value.confirmed === true }]
    })
  } catch { return [] }
}
/** Video retains its 20 MB/256px first-frame contract independently of image chat. */
async function readFirstFrame(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error('首帧图片不能超过 20 MB')
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('首帧请使用 PNG、JPG 或 WebP 图片')
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const actual = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'image/webp' : ''
  if (actual !== file.type) throw new Error('首帧图片格式与内容不符')
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('首帧图片无法解码，请重新上传') })
  try { if (bitmap.width < 256 || bitmap.height < 256) throw new Error('首帧图片宽高至少需要 256 像素') } finally { bitmap.close() }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取首帧图片'))
    reader.onerror = () => reject(new Error('无法读取首帧图片'))
    reader.readAsDataURL(file)
  })
}
export function VideoStudio({ accountId, quota, videoJob, videoBusy, videoError, submitVideo, pendingVideo, checkPendingVideo, retryJob }: Props) {
  const [turns, setTurns] = useState<Turn[]>(() => restoreTurns(accountId))
  const [replying, setReplying] = useState(false)
  const [image, setImage] = useState<Upload | null>(null)
  const [localError, setLocalError] = useState('')
  const requestVersion = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const turnsRef = useRef(turns); turnsRef.current = turns
  const imageRef = useRef(image); imageRef.current = image
  const alive = useRef(true)
  const client = useQueryClient()
  const usageQuery = useQuery({ queryKey: ['chat', 'usage', accountId], queryFn: chatUsage, enabled: Boolean(accountId), staleTime: 30_000, retry: 1 })
  const usage = usageQuery.data || { used: 0, limit: 50 }
  const activeJob = videoJob && !['done', 'failed'].includes(videoJob.status) ? videoJob : null
  useEffect(() => { alive.current = true; return () => { alive.current = false; requestVersion.current++; abortRef.current?.abort() } }, [])
  useEffect(() => {
    if (!accountId) return
    try { sessionStorage.setItem(draftKey(accountId), JSON.stringify(turns.filter(turn => turn.status !== 'streaming').slice(-12))) } catch { /* Draft storage failure cannot weaken the mandatory paid request key. */ }
  }, [turns, accountId])
  const patch = (id: string, update: (turn: Turn) => Turn) => setTurns(old => old.map(turn => turn.id === id ? update(turn) : turn))
  const stop = () => {
    requestVersion.current++; abortRef.current?.abort(); abortRef.current = null; setReplying(false)
    setTurns(old => old.map(turn => turn.status === 'streaming' ? { ...turn, status: 'stopped', storyboard: undefined } : turn))
  }
  const send = async (text: string, upload?: Upload, retry = false) => {
    if (!accountId || abortRef.current || videoBusy || !text.trim() || text.length > 2000) return
    setLocalError(''); if (upload) { imageRef.current = upload; setImage(upload) }
    const prior = retry ? turnsRef.current.slice(0, -1) : turnsRef.current
    const context: VideoMessage[] = prior.slice(-8).flatMap(turn => {
      const content = turn.storyboard ? `${turn.text}\n${JSON.stringify(turn.storyboard)}` : turn.text
      return [{ role: 'user' as const, content: turn.user }, ...(content ? [{ role: 'assistant' as const, content: content.slice(0, 2000) }] : [])]
    })
    context.push({ role: 'user', content: text.trim() })
    const id = crypto.randomUUID(), version = ++requestVersion.current, controller = new AbortController()
    abortRef.current = controller; setTurns([...prior, { id, user: text.trim(), text: '', status: 'streaming' }]); setReplying(true)
    const latest = prior.at(-1)?.storyboard
    let proposed: VideoStoryboard | undefined
    const timeout = setTimeout(() => controller.abort(), 180_000)
    try {
      await streamVideoChat(context, latest ? { duration: latest.duration, ratio: latest.ratio, resolution: latest.resolution } : { duration: 10 }, {
        onDelta: value => { if (alive.current && version === requestVersion.current) patch(id, turn => ({ ...turn, text: turn.text + value })) },
        onStoryboard: value => { proposed = value },
        onMeta: (used, limit) => { if (alive.current && version === requestVersion.current) client.setQueryData(['chat', 'usage', accountId], { used, limit }) },
      }, controller.signal)
      if (alive.current && version === requestVersion.current) patch(id, turn => ({ ...turn, status: 'ready', storyboard: proposed ? { ...proposed, resolution: imageRef.current ? proposed.resolution : '768P' } : undefined }))
    } catch (reason) {
      if (alive.current && version === requestVersion.current) patch(id, turn => ({ ...turn, status: 'error', error: controller.signal.aborted ? '分镜对话超时，请重试；尚未提交视频任务' : msg(reason), storyboard: undefined }))
    } finally {
      clearTimeout(timeout); if (abortRef.current === controller) abortRef.current = null
      if (alive.current && version === requestVersion.current) setReplying(false)
    }
  }
  const confirm = async (turn: Turn) => {
    const plan = turn.storyboard
    if (!plan || replying || videoBusy || turn.confirmed) return
    const prompt = compileStoryboard(plan)
    if (!prompt) { setLocalError('请补全镜头内容，并将分镜描述控制在 2000 字内'); return }
    if (!pendingVideo && quota !== null && quota < plan.duration * 120) { setLocalError(`余额不足：${plan.duration} 秒视频预计 ${cost(plan.duration)}`); return }
    setLocalError(''); await submitVideo({ prompt, duration: plan.duration, ratio: plan.ratio, resolution: image ? plan.resolution : '768P', image: image?.dataUrl || '' })
  }
  useEffect(() => { if (videoJob) setTurns(old => old.map(turn => turn.storyboard && compileStoryboard(turn.storyboard) === videoJob.prompt ? { ...turn, confirmed: videoJob.status !== 'failed' } : turn)) }, [videoJob])
  const download = (job: VideoJob) => { if (!job.url) return; const link = document.createElement('a'); link.href = job.url; link.download = `jianlai-video-${job.id}.mp4`; link.target = '_blank'; link.rel = 'noopener'; link.click() }
  const latestTurn = turns.at(-1)
  const renderPlan = (turn: Turn, index: number) => {
    const plan = turn.storyboard, latest = index === turns.length - 1, disabled = !latest || turn.confirmed || replying || videoBusy
    let end = 0
    return plan ? <div className="jl-video-plan"><header><strong>分镜工作区</strong><span className="text-xs text-muted-foreground">{plan.shots.length} 个镜头 · {plan.duration} 秒 · 一条完整视频</span></header>
          {plan.notice ? <p className="jl-video-notice mx-4" role="note">{plan.notice}</p> : null}
          <div className="jl-video-shots" role="list" aria-label="视频分镜镜头">{plan.shots.map((shot, shotIndex) => {
            const start = end; end += shot.duration
            const change = (field: 'scene' | 'camera', value: string) => patch(turn.id, current => ({ ...current, storyboard: { ...plan, shots: plan.shots.map((item, i) => i === shotIndex ? { ...item, [field]: value } : item) } }))
            return <div className="jl-video-shot" key={shotIndex} role="listitem"><span className="jl-video-shot-time">{start}–{end}秒</span><div className="jl-video-shot-fields"><label>镜头 {shotIndex + 1} · 画面<textarea aria-label={`镜头${shotIndex + 1}画面`} rows={2} value={shot.scene} maxLength={200} disabled={disabled} onChange={event => change('scene', event.target.value)} /></label><label>运镜<textarea aria-label={`镜头${shotIndex + 1}运镜`} rows={1} value={shot.camera} maxLength={80} disabled={disabled} onChange={event => change('camera', event.target.value)} /></label><div className="jl-video-shot-actions">{[
              { label: '上移', update: () => moveStoryboardShot(plan, shotIndex, shotIndex - 1), unavailable: shotIndex === 0 },
              { label: '下移', update: () => moveStoryboardShot(plan, shotIndex, shotIndex + 1), unavailable: shotIndex === plan.shots.length - 1 },
              { label: '复制', update: () => duplicateStoryboardShot(plan, shotIndex), unavailable: plan.shots.length >= Math.min(6, plan.duration) },
              { label: '删除', update: () => removeStoryboardShot(plan, shotIndex), unavailable: plan.shots.length === 1 },
            ].map(action => <Button key={action.label} variant="secondary" size="small" aria-label={`镜头${shotIndex + 1}${action.label}`} disabled={Boolean(disabled) || action.unavailable} onClick={() => patch(turn.id, current => ({ ...current, storyboard: action.update() }))}>{action.label}</Button>)}</div></div></div>
          })}</div>
          <p className="jl-video-edit-hint">复制或删除镜头会重新分配时长，总时长保持不变。首帧用于整条视频，不逐镜头生成。</p><div className="jl-video-options"><label>总时长<select aria-label="视频总时长" value={plan.duration} disabled={disabled} onChange={event => patch(turn.id, current => ({ ...current, storyboard: resizeStoryboard(plan, Number(event.target.value)) }))}>{Array.from({ length: 12 }, (_, i) => i + 4).filter(duration => duration >= plan.shots.length).map(duration => <option key={duration} value={duration} disabled={duration < turn.storyboard!.shots.length}>{duration} 秒</option>)}</select></label><label>画幅<select aria-label="视频画幅" value={plan.ratio} disabled={disabled || Boolean(image)} onChange={event => patch(turn.id, current => ({ ...current, storyboard: { ...plan, ratio: event.target.value as VideoStoryboard['ratio'] } }))}>{['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map(ratio => <option key={ratio}>{ratio}</option>)}</select></label><label>清晰度<select aria-label="视频清晰度" value={plan.resolution} disabled={disabled} onChange={event => patch(turn.id, current => ({ ...current, storyboard: { ...plan, resolution: event.target.value as VideoStoryboard['resolution'] } }))}><option>768P</option>{image ? <option>2K</option> : null}</select></label></div>
          <div className="jl-video-confirm"><span className="text-sm text-muted-foreground">预计 {cost(plan.duration)} · ¥1.20 / 秒</span><Button disabled={Boolean(disabled) || !compileStoryboard(plan)} onClick={() => void confirm(turn)}>{turn.confirmed ? '已提交视频' : index !== turns.length - 1 ? '已有更新分镜' : videoBusy ? '生成中' : '确认分镜并生成视频'}</Button></div></div> : null
  }
  return <section className={`jl-video-conversation${latestTurn?.storyboard ? ' jl-video-workspace' : ''}`} aria-label="视频对话">
    {latestTurn?.storyboard ? <div className="jl-video-editor">{renderPlan(latestTurn, turns.length - 1)}</div> : null}
    <div className="jl-video-dialogue">
    {!turns.length && !videoJob ? <div className="jl-video-welcome"><span className="text-sm text-muted-foreground">AI 创作工作台</span><h1>创建视频</h1><p>描述想法，一起把它整理成镜头。</p><p className="text-sm">未指定时长时按 10 秒分镜，单次最多生成 15 秒。</p></div> : null}
    <div className="jl-video-messages" aria-live="polite">{turns.map((turn, index) => {
      const plan = turn.storyboard, latest = index === turns.length - 1
      return <div key={turn.id} className="grid gap-5"><div className="jl-video-user">{turn.user}</div><div className="jl-video-assistant"><div className="jl-video-identity"><img src={avatar} alt="" /><strong>剑来</strong><span>创作助手</span></div>
        {turn.text ? <p className="whitespace-pre-wrap text-sm leading-6">{turn.text}</p> : turn.status === 'streaming' ? <p role="status" className="text-sm text-muted-foreground">正在整理分镜…</p> : null}
        {turn.status === 'error' ? <div className="jl-video-notice" role="alert"><p>{turn.error}</p><Button variant="secondary" size="small" onClick={() => void send(turn.user, undefined, true)} disabled={!latest || replying || videoBusy}>重试分镜</Button></div> : null}
        {turn.status === 'stopped' ? <p className="text-sm text-muted-foreground">已停止回复，尚未提交视频任务。</p> : null}
        {plan && !latest ? <details className="jl-video-history"><summary>历史分镜 · {plan.shots.length} 个镜头 · {plan.duration} 秒</summary><ol>{plan.shots.map((shot, shotIndex) => <li key={shotIndex}>{shot.scene}<span>{shot.duration} 秒 · {shot.camera}</span></li>)}</ol></details> : null}
      </div></div>
    })}
      {activeJob ? <div className="jl-video-progress" role="status"><div className="flex justify-between gap-3"><strong>正在生成</strong><span>{activeJob.progress || 0}%</span></div><progress max={100} value={Math.min(95, activeJob.progress || 1)} /><p className="text-sm text-muted-foreground">可以离开页面，回来后会继续显示任务进度。</p></div> : null}
      {videoJob?.status === 'done' && videoJob.url ? <div className="jl-video-result"><video src={videoJob.url} controls playsInline preload="metadata" /><div className="jl-video-result-meta"><div><p className="text-sm font-medium">生成完成 · {videoJob.duration} 秒</p><p className="text-xs text-muted-foreground">已扣 ¥{((videoJob.chargedCents || 0) / 100).toFixed(2)} · 已保存到作品画廊</p></div><Button size="small" variant="secondary" leadingIcon={DownloadIcon} onClick={() => download(videoJob)}>下载视频</Button></div></div> : null}
      {videoError ? <div className="jl-video-notice" role="alert"><p>{videoError}</p>{activeJob ? <Button variant="secondary" size="small" onClick={retryJob}>重试查询进度</Button> : null}</div> : null}
      {pendingVideo ? <Button variant="secondary" onClick={() => void checkPendingVideo()} disabled={videoBusy}>核对上次提交</Button> : null}
      {localError ? <p role="alert" className="text-sm text-destructive">{localError}</p> : null}
    </div>
    <div className="jl-video-footer">{image ? <div className="jl-video-upload"><img src={image.dataUrl} alt="视频首帧" /><div className="min-w-0 flex-1"><p className="truncate">{image.name}</p><p>视频将从此首帧延展；刷新后需重新上传。</p></div><Button variant="ghost" size="small" iconOnly leadingIcon={XIcon} aria-label="移除视频首帧" disabled={replying || videoBusy || pendingVideo} onClick={() => { setImage(null); setTurns(old => old.map(turn => turn.storyboard ? { ...turn, storyboard: { ...turn.storyboard, resolution: '768P' } } : turn)) }} /></div> : null}
      <div className="jl-composer-shell"><Composer replying={replying} usage={usage} editing={false} disabled={!accountId || videoBusy} label="描述你想要的视频" placeholder="描述你想要的视频，或继续调整分镜…" uploadLabel="上传视频首帧" uploadHint="作为视频首帧；请在消息中描述镜头如何延展。" uploadReader={readFirstFrame} onSend={(text, upload) => void send(text, upload)} onStop={stop} /></div>
      <p className="mt-2 text-center text-xs text-muted-foreground">确认分镜前不提交视频任务。未指定时长默认 10 秒，单次最多 15 秒。</p>
    </div>
    </div>
  </section>
}
