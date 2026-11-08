import { useEffect, useRef, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import './generation-waiting.css'

type Props = {
  size: string
  total: number
  started: number
  submitting: boolean
  phase?: string
  pollingError: string
  onStop: () => void
  onRetryPoll: () => void
}

const phases: Record<string, { title: string; detail: string }> = {
  submitting: { title: '正在提交', detail: '正在发送生成请求。' },
  queued: { title: '排队中', detail: '服务端已接单，等待开始。' },
  generating: { title: '生成中', detail: '正在生成图片，完成后会显示在这里。' },
  saving: { title: '正在保存', detail: '正在保存生成结果，完成后即可查看。' },
}

export function GenerationWaiting({ size, total, started, submitting, phase, pollingError, onStop, onRetryPoll }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [inView, setInView] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const state = phases[submitting ? 'submitting' : phase ?? ''] ?? { title: '处理中', detail: '正在等待服务端更新任务状态。' }
  const dimensions = /^(\d+)x(\d+)$/.exec(size)
  const ratio = dimensions && Number(dimensions[2]) > 0 ? Number(dimensions[1]) / Number(dimensions[2]) : 1.5
  const seconds = Math.max(0, Math.floor((now - started) / 1000))

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
    if (root.current) observer?.observe(root.current)
    return () => {
      document.removeEventListener('visibilitychange', update)
      observer?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!visible || !inView) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible, inView, started])

  return (
    <div ref={root} className="generation-waiting" data-motion-paused={!visible || !inView}>
      <div className={`generation-canvases ${total > 1 ? 'generation-canvases-pair' : ''}`} aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <div key={index} className="chat-skeleton generation-canvas" style={{ aspectRatio: String(ratio), width: `min(100%, calc(min(28dvh, 224px) * ${ratio}))` }}>
            <div className="generation-canvas-frame" />
            <div className="generation-canvas-orbit"><span /></div>
            <ImageIcon className="generation-canvas-icon" size={28} strokeWidth={1.5} />
            <span className="generation-canvas-label">画布 {String(index + 1).padStart(2, '0')}</span>
          </div>
        ))}
      </div>
      <div className="generation-status-row">
        <div className="generation-status-copy">
          <span className="generation-phase" role="status"><span className="generation-pulse" aria-hidden="true" />{state.title}</span>
          <span className="generation-elapsed">已用 {seconds} 秒</span>
        </div>
        <Button variant="secondary" size="xs" onClick={onStop}>停止等待</Button>
      </div>
      <div className="chat-progress generation-progress" role="progressbar" aria-label="生成进度" aria-valuetext={state.title} />
      <p className="generation-detail">{state.detail}停止等待不会取消服务端任务。</p>
      {pollingError ? <div role="alert" className="generation-poll-error text-destructive"><p>{pollingError}</p><Button variant="secondary" size="xs" onClick={onRetryPoll}>继续查询</Button></div> : null}
    </div>
  )
}
