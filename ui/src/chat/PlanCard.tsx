import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { CheckIcon, XIcon, SearchIcon, ChevronDownIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { Textarea } from '@/components/ai/textarea'
import { Input } from '@/components/ai/input'
import { Pick } from './Pick'
import { searchPublicFigure } from './api'
import { getPublicFigureNames, getPublicFigureContext, figureSourceKey, validateFigureSources, validatePlanFigureSources } from './public-figures'
import './plan-card.css'
import type { AssistantItem, Capabilities, Plan, PublicFigureSource } from './types'

export const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`

type Props = {
  item: AssistantItem & { plan: Plan }
  caps: Capabilities
  balance: number | null
  busy: boolean
  onChange: (plan: Plan) => void
  onConfirm: () => void
  onDismiss: () => void
  onRebindReference?: (file: File) => Promise<void>
  onUploadReference?: (file: File) => Promise<void>
}

const countOptions = [
  { value: '1', label: '1 张' },
  { value: '2', label: '2 张' },
]

export function PlanCard({ item, caps, balance, busy, onChange, onConfirm, onDismiss, onRebindReference, onUploadReference }: Props) {
  const { plan, reference } = item
  const reducedMotion = useReducedMotion()
  const [binding, setBinding] = useState(false)
  const [bindingError, setBindingError] = useState('')
  const missingReference = plan.useReference && reference?.kind === 'upload' && !reference.preview
  const names = getPublicFigureNames(plan)
  const namesKey = JSON.stringify(names)
  const context = getPublicFigureContext(plan)
  const latest = useRef({ plan, onChange, reference })
  useEffect(() => { latest.current = { plan, onChange, reference } }, [plan, onChange, reference])
  const updatePerson = (name: string, selected: PublicFigureSource[]) => {
    const current = latest.current
    const next = { ...current.plan, publicFigureSource: undefined,
      publicFigureSources: [...(current.plan.publicFigureSources ?? []).filter(source => source.personName !== name && getPublicFigureNames(current.plan).includes(source.personName ?? '')), ...selected],
      useReference: current.reference ? current.plan.useReference : true, count: 1 as const }
    latest.current.plan = next
    current.onChange(next)
  }
  const skipFigureReferences = () => onChange({
    ...latest.current.plan,
    publicFigureVisual: false,
    publicFigure: undefined,
    publicFigures: [],
    publicFigureContext: undefined,
    publicFigureSource: undefined,
    publicFigureSources: [],
  })
  const selectedSources = validatePlanFigureSources(plan)
  const capacityExceeded = Boolean(plan.useReference && reference && (plan.publicFigureSources?.length ?? names.length * 2) + 1 > 4)
  const figuresReady = !names.length || (selectedSources.length >= names.length * 2 && !capacityExceeded)

  const cost = plan.count * caps.priceCents
  const short = balance != null && balance < cost
  const label = (options: { value: string; label: string }[], v: string) =>
    options.find((o) => o.value === v)?.label ?? v
  if (item.planState !== 'open') {
    const done = item.planState === 'submitted'
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        {done ? <CheckIcon aria-hidden="true" className="size-4 text-primary" /> : <XIcon aria-hidden="true" className="size-4" />}
        <span className="truncate">
          {done
            ? `生成方案 · ${label(caps.sizes, plan.size)} · ${label(caps.qualities, plan.quality)} · ${plan.count} 张 · ${yuan(cost)}`
            : '已放弃这个方案'}
        </span>
      </div>
    )
  }
  const set = (patch: Partial<Plan>) => onChange({ ...plan, ...patch, ...(names.length ? { count: 1 } : {}) })
  const referenceUpload = reference?.kind === 'upload' ? (
    <div className="jl-plan-reference-upload">
      {missingReference ? <p role="status">刷新后需要重新选择参考图，原方案已保留。</p> : null}
      <label className="grid gap-1">
        {binding ? '正在校验参考图…' : '重新绑定参考图'}
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={binding || busy} aria-label="重新绑定参考图" onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file || !onRebindReference) return
          setBinding(true)
          setBindingError('')
          try { await onRebindReference(file) }
          catch (error) { setBindingError(error instanceof Error ? error.message : '参考图读取失败，请重新选择') }
          finally { setBinding(false) }
        }} />
      </label>
      {bindingError ? <p role="alert" className="text-destructive">{bindingError}</p> : null}
    </div>
  ) : null
  return (
    <motion.section
      initial={reducedMotion ? false : { opacity: 0, transform: 'translateY(8px)' }}
      animate={{ opacity: 1, transform: 'translateY(0px)' }}
      transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}
      aria-label="生成方案"
      className="jl-plan grid w-full max-w-xl gap-2 rounded-xl border border-border bg-card p-3.5 text-card-foreground"
    >
      <div className="jl-plan-heading"><h3 className="text-sm font-semibold">生成方案</h3>
      <p className="jl-plan-parameters">
        {label(caps.sizes, plan.size)} · {label(caps.qualities, plan.quality)} · {plan.count} 张
        {plan.useReference ? ' · 使用参考图' : ''}
        {plan.text ? ' · 含画面文字' : ''}
      </p></div>
      <p className="jl-plan-summary">{plan.prompt || '请补充画面描述'}</p>
      {reference && !missingReference ? (
        <div className="jl-plan-current-reference" aria-label="本次方案参考图">
          {plan.useReference && reference.preview ? <img src={reference.preview} alt="本次方案参考图" className="size-9 shrink-0 rounded-md object-cover" /> : null}
          <span>{plan.useReference ? (reference.kind === 'upload' ? `使用本次上传：${reference.name}` : '使用你指定修改的图片') : '本次方案不使用参考图'}</span>
        </div>
      ) : null}
      {missingReference ? referenceUpload : null}
      {reference?.preview ? (
        <div className="jl-plan-reference">
          <img src={reference.preview} alt="参考图" className="size-11 rounded-lg object-cover" />
          <span className="min-w-0 flex-1">
            {reference.kind === 'upload' ? '已上传' : '所选图片'}
            {reference.kind !== 'upload' && reference.marks?.length ? ` · ${reference.marks.length} 处标记` : ''}
          </span>
          <Button variant="secondary" size="small" onClick={() => set({ useReference: !plan.useReference, count: 1 })}>
            {plan.useReference ? '不用参考图' : '用作参考图'}
          </Button>
        </div>
      ) : null}
      {names.length ? (
        <section className="jl-plan-sources" aria-label="人物参考图">
          {names.map(name => <PersonReferences key={`${namesKey}:${context ?? ''}:${name}`} name={name} context={context} open={item.planState === 'open'} multiple={names.length > 1} plan={plan} limit={plan.useReference && reference ? 3 : 4} busy={busy} onChange={updatePerson} onSkip={skipFigureReferences} onUploadReference={onUploadReference} />)}
          {capacityExceeded ? <p role="alert" className="text-destructive">最多使用 4 张参考图。双人身份各需至少 2 张，请先关闭上传底图参考，再确认生成。</p> : null}
          {!selectedSources.length && (plan.publicFigureSources?.length ?? 0) > 0 ? <p role="status">请为每位人物至少选择 2 张不同的照片，且不同人物不能使用同一身份。</p> : null}
        </section>
      ) : null}
      <details className="jl-plan-details">
        <summary>编辑方案<ChevronDownIcon aria-hidden="true" className="size-4" /></summary>
        <div className="jl-plan-editor">
          <label className="grid gap-1 text-sm text-muted-foreground">
            画面描述
            <Textarea value={plan.prompt} maxLength={4000} onChange={(e) => set({ prompt: e.target.value })} className="min-h-24 text-foreground" />
          </label>
          <label className="grid gap-1 text-sm text-muted-foreground">
            画面文字（可选）
            <Input value={plan.text} maxLength={1500} onChange={(e) => set({ text: e.target.value })} />
          </label>
          {!missingReference ? referenceUpload : null}
          <div className="flex flex-wrap items-center gap-2">
            <Pick label="画幅" value={plan.size} options={caps.sizes} onChange={(size) => set({ size })} />
            <Pick label="质量" value={plan.quality} options={caps.qualities} onChange={(quality) => set({ quality })} />
            <Pick label="张数" value={String(plan.count)} options={countOptions} disabled={plan.useReference || Boolean(names.length)} onChange={(v) => set({ count: v === '2' ? 2 : 1 })} />
          </div>
          {plan.useReference ? <p className="text-sm text-muted-foreground">使用参考图时每次生成 1 张。</p> : null}
        </div>
      </details>
      <div className="jl-plan-footer">
        <div className="jl-plan-cost">
          <span>预计 <strong className="text-foreground">{yuan(cost)}</strong></span>
          {short ? <span role="status" className="text-destructive">余额不足</span> : null}
        </div>
        <div className="jl-plan-actions">
          <Button variant="ghost" onClick={onDismiss}>放弃方案</Button>
          <Button aria-label={busy ? '已有任务生成中' : '生成'} onClick={onConfirm} disabled={busy || short || binding || missingReference || !figuresReady || !plan.prompt.trim()}>
            {busy ? '已有任务生成中' : '确认生成'}
          </Button>
        </div>
        <p className="jl-plan-fee-note">确认后开始生成，按实际结果计费</p>
      </div>
    </motion.section>
  )
}

function PersonReferences({ name, context, open, multiple, plan, limit, busy, onChange, onSkip, onUploadReference }: {
  name: string; context?: string; open: boolean; multiple: boolean; plan: Plan; limit: number; busy: boolean
  onChange: (name: string, selected: PublicFigureSource[]) => void
  onSkip?: () => void
  onUploadReference?: (file: File) => Promise<void>
}) {
  const [binding, setBinding] = useState(false)
  const [bindingError, setBindingError] = useState('')
  const [sources, setSources] = useState<PublicFigureSource[]>([])
  const [searching, setSearching] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const latestChange = useRef(onChange)
  useEffect(() => { latestChange.current = onChange }, [onChange])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let current = true
    setSearching(true)
    setError('')
    setSources([])
    latestChange.current(name, [])
    void searchPublicFigure(name, controller.signal, context).then(found => {
      if (!current) return
      setSources(found)
      latestChange.current(name, found.slice(0, multiple ? 2 : 3))
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : '人物图片搜索暂时不可用')
    }).finally(() => { if (current) setSearching(false) })
    return () => { current = false; controller.abort() }
  }, [name, context, open, multiple, attempt])
  const selected = (plan.publicFigureSources ?? []).filter(source => source.personName === name)
  return <div aria-label={`人物参考 · ${name}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>人物参考 · {name}</span>
      <Button variant="secondary" size="small" disabled={searching} onClick={() => setAttempt(value => value + 1)} leadingIcon={SearchIcon} aria-label={multiple ? `重新搜索${name}人物图片` : '重新搜索人物图片'}>重新搜索人物图片</Button>
    </div>
    {searching ? <p role="status">{multiple ? `${name}：` : ''}正在搜索同一人物的多张参考图…</p> : null}
    {error ? <p role="alert" className="text-destructive">{multiple ? `${name}：` : ''}{error}</p> : null}
    {error && onSkip ? <>
      <p role="status">公开搜索不到可核验的人物图片。你可以上传人物参考图继续生成，或去掉人物参考直接生成。</p>
      {onUploadReference ? <label className="jl-plan-reference-upload">
        上传人物参考图
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || binding} aria-label="上传人物参考图" onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setBinding(true)
          setBindingError('')
          try { await onUploadReference(file) }
          catch (cause) { setBindingError(cause instanceof Error ? cause.message : '参考图读取失败，请重试') }
          finally { setBinding(false) }
        }} />
      </label> : null}
      {bindingError ? <p role="alert" className="text-destructive">{bindingError}</p> : null}
      <Button variant="ghost" size="small" onClick={onSkip}>去掉人物参考，继续生成</Button>
    </> : null}
    {sources.length ? <>
      {sources.some(source => source.provider === 'Sogou/Sina') ? <p>国内来源页未标注许可，仅作人物身份参考；请核对原始报道与人物。</p> : null}
      <p>已选 {selected.length} 张，至少保留 2 张。用于人物身份，场景、服装与构图仍按你的要求。</p>
      <details className="jl-plan-details">
        <summary>核对人物与图片来源<ChevronDownIcon aria-hidden="true" className="size-4" /></summary>
        <div className="jl-plan-sample-list">{sources.map(source => {
          const checked = selected.some(entry => entry.imageUrl === source.imageUrl)
          return <label key={figureSourceKey(source) ?? source.imageUrl} className="jl-plan-source">
            <input type="checkbox" aria-label={`选择参考图 ${source.title}`} checked={checked} disabled={!checked && (plan.publicFigureSources?.length ?? 0) >= limit} onChange={event => onChange(name, event.target.checked ? sources.filter(candidate => candidate.imageUrl === source.imageUrl || selected.some(entry => entry.imageUrl === candidate.imageUrl)) : selected.filter(entry => entry.imageUrl !== source.imageUrl))} />
            <img src={source.thumbUrl} alt={source.title} className="size-10 rounded object-cover" loading="lazy" />
            <span className="min-w-0 flex-1"><a href={source.sourceUrl} target="_blank" rel="noreferrer" className="block underline">{source.title}</a><span className="block text-muted-foreground">{source.artist} · {source.license}</span></span>
          </label>
        })}</div>
      </details>
      {!validateFigureSources(selected).length ? <p role="status">请至少选择 2 张不同的同一人物照片，再确认生成。</p> : null}
    </> : null}
  </div>
}
