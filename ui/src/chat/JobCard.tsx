import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { AlertCircleIcon, DownloadIcon, ExpandIcon, PencilIcon } from 'lucide-react'
import { Button, ButtonLink } from '@/boardui/button'
import { yuan } from './PlanCard'
import type { JobImage, JobItem } from './types'
import { GenerationWaiting } from './GenerationWaiting'

type Props = {
  item: JobItem
  onStop: () => void
  onRetryPoll: () => void
  onRetryGeneration: () => void
  onRebindReference?: (file: File) => Promise<void>
  onOpen: (image: JobImage) => void
  onEdit: (image: JobImage) => void
}

/** Tallest a picture or its placeholder may be, so it fits small screens. */
export const MAX_IMAGE_HEIGHT = '50dvh'

/** Width / height of a "WxH" size, 1.5 when the size is "auto" or unknown. */
export function ratioNumber(size: string) {
  const m = /^(\d+)x(\d+)$/.exec(size)
  return m ? Number(m[1]) / Number(m[2]) : 1.5
}

export function JobCard({ item, onStop, onRetryPoll, onRetryGeneration, onRebindReference, onOpen, onEdit }: Props) {
  const reducedMotion = useReducedMotion()
  const [binding, setBinding] = useState(false)
  const [bindingError, setBindingError] = useState('')
  const missingReference = item.plan.useReference && item.reference?.kind === 'upload' && !item.reference.preview
  const active = item.status === 'submitting' || item.status === 'running'
  const pollingError = active && item.error?.startsWith('查询任务失败：') ? item.error : ''
  const total = item.plan.useReference ? 1 : item.plan.count
  const legacySource = item.reference?.kind !== 'upload' ? item.reference?.source : undefined
  const sources = [...(item.plan.publicFigureSources || []), ...(item.plan.publicFigureSource ? [item.plan.publicFigureSource] : []), ...(legacySource ? [legacySource] : [])]
    .filter((source, index, all) => all.findIndex(candidate => candidate.imageUrl === source.imageUrl) === index)
  if (item.status === 'failed' || item.status === 'unknown') {
    return (
      <div role="alert" className="job-card-error flex max-w-xl items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="grid gap-2">
          {item.plan.useReference && item.reference?.kind === 'upload' ? (
            <label className="grid gap-1">
              {missingReference ? '刷新后请重新绑定原参考图，再重试此任务。' : '参考图已绑定，可继续原任务。'}
              <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="重新绑定任务参考图" disabled={binding} onChange={async (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file || !onRebindReference) return
                setBinding(true)
                setBindingError('')
                try { await onRebindReference(file) }
                catch (error) { setBindingError(error instanceof Error ? error.message : '参考图读取失败，请重新选择') }
                finally { setBinding(false) }
              }} />
              {binding ? <span>正在校验参考图…</span> : null}
              {bindingError ? <span>{bindingError}</span> : null}
            </label>
          ) : null}
          <span>{item.error || '生成失败，费用状态未知，请到画廊核对任务'}</span><span className="text-sm text-muted-foreground">{item.status === 'failed' && item.phase === 'failed' && item.chargedCents != null ? `服务端确认失败 · ${item.chargedCents === 0 ? '未扣费 · ' : ''}实际费用 ${yuan(item.chargedCents)}` : '最终状态和费用待确认，请先核对原任务。'}</span>{item.jobId ? <Button variant="secondary" size="xs" onClick={onRetryPoll}>继续查询</Button> : null}{!item.jobId ? <Button variant="secondary" size="xs" disabled={binding || missingReference} onClick={onRetryGeneration}>按原请求继续提交</Button> : null}{item.jobId && item.status === 'failed' && item.phase === 'failed' ? <Button variant="secondary" size="xs" disabled={binding || missingReference} onClick={onRetryGeneration}>按原方案重新生成</Button> : null}</div>
      </div>
    )
  }
  return (
    <div className={`job-card grid w-full gap-3 rounded-xl border border-border bg-card p-3 ${total > 1 ? 'max-w-2xl' : 'max-w-md'}`}>
      {active ? <GenerationWaiting size={item.plan.size} total={total} started={item.started} submitting={item.status === 'submitting'} phase={item.phase} pollingError={pollingError} onStop={onStop} onRetryPoll={onRetryPoll} /> : <div className={`grid gap-3 ${total > 1 ? 'grid-cols-2' : 'grid-cols-1 max-w-md'}`}>
        {item.images.map((image) => (
              <motion.figure
                key={image.id}
                initial={reducedMotion ? false : { opacity: 0, transform: 'translateY(4px) scale(0.99)' }}
                animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
                transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="group relative m-0 overflow-hidden rounded-lg bg-muted"
              >
                <div className="relative">
                  <img src={image.preview} alt={image.prompt} loading="lazy" decoding="async" className="mx-auto block h-auto max-h-[50dvh] w-auto max-w-full object-contain" />
                  <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-black/40 p-2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <Button size="small" iconOnly leadingIcon={PencilIcon} variant="secondary" title="修改这张图" aria-label="修改这张图" onClick={() => onEdit(image)} />
                  <Button size="small" iconOnly leadingIcon={ExpandIcon} variant="secondary" title="放大查看" aria-label="放大查看" onClick={() => onOpen(image)} />
                  <ButtonLink
                    size="small"
                    iconOnly
                    leadingIcon={DownloadIcon}
                    variant="secondary"
                    title="下载原图" aria-label="下载原图"
                    href={image.download} download={`jianlai-${image.id}.png`} target="_blank" rel="noreferrer"
                  />
                  </div>
                </div>
                <figcaption className="p-2 text-sm text-muted-foreground">如果上下文干扰，请清空对话。</figcaption>
              </motion.figure>
            ))}
      </div>}
      {!active && item.images.length > 0 && sources.length > 0 ? <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">人物参考来源 · {sources.length} 张</summary>
        <ul className="mt-2 grid gap-2 pl-4">
          {sources.map(source => <li key={source.imageUrl}><a href={source.sourceUrl} target="_blank" rel="noreferrer" className="underline">{source.title}</a>{source.personName ? ` · ${source.personName}` : ''} · {source.artist} · {source.license}</li>)}
        </ul>
      </details> : null}
      {!active ? (
        <div className="text-sm text-muted-foreground">
          已完成 · {item.images.length} 张{item.chargedCents != null ? ` · 实际费用 ${yuan(item.chargedCents)}` : ''}
          {item.images.length < total || item.error ? <p role="alert" className="mt-2 text-sm text-foreground">部分成功：已交付 {item.images.length}/{total} 张，未完成 {Math.max(0, total - item.images.length)} 张。{item.error || '其余图片未交付，请核对任务结果。'}如需补生成，请另行确认数量与费用。</p> : null}
        </div>
      ) : null}
    </div>
  )
}
