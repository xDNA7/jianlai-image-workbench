import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, ChevronDown, Ellipsis, Film, Image, Images, Menu, PanelLeftClose, PanelRightClose, Pencil, Plus, ScanLine, SquarePen, Star, X } from 'lucide-react'
import { Dialog, Modal, ModalOverlay } from 'react-aria-components'
import { Button } from '../boardui/button'
import { Composer } from '../chat/Composer'
import { useMinWidth } from '../chat/SideDrawer'
import { fileToDataUrl } from '../chat/api'
import type { Upload } from '../chat/useWorkbench'
import type { Plan } from '../chat/types'
import logo from '../assets/brand-logo.png'
import account from '../assets/account-avatar.webp'
import orange from './orange-example.webp'
import architecture from './architecture-example.webp'
import './playground.css'

type Stage = 'welcome' | 'plan' | 'running' | 'done' | 'partial' | 'failed' | 'unknown'
type View = 'chat' | 'templates'
const INITIAL_PLAN: Plan = { prompt: '一张夏日橙子汽水新品海报。橙子与气泡水作为主体，明亮的自然光，清爽的奶白色背景，保留简洁留白。', text: '一口，喝进夏天', size: '1024x1536', quality: 'medium', count: 1, useReference: false }
const EXAMPLES = [
  { title: '做一张海报', detail: '把新品、活动或课程讲清楚', Icon: Image, text: '为一杯橙子汽水设计夏日新品海报，明亮自然光、奶白色背景，标题“一口，喝进夏天”。' },
  { title: '拍出产品质感', detail: '从一件产品开始，设计一个场景', Icon: ScanLine, text: '为一瓶香水设计极简产品摄影场景，柔和侧光、自然阴影，大面积留白。' },
  { title: '修改一张图片', detail: '上传参考图，说说想改哪里', Icon: Pencil, text: '保留参考图的主体与构图，只调整背景和配色，让画面更简洁。' },
]
const STAGES: { value: Stage; label: string }[] = [
  { value: 'welcome', label: '开始创作' }, { value: 'plan', label: '确认方案' }, { value: 'running', label: '生成中' },
  { value: 'done', label: '已完成' }, { value: 'partial', label: '部分成功' }, { value: 'failed', label: '生成失败' }, { value: 'unknown', label: '停止等待' },
]

function Surface({ title, open, close, children, className = '' }: { title: string; open: boolean; close: () => void; children: ReactNode; className?: string }) {
  return <ModalOverlay isOpen={open} onOpenChange={value => { if (!value) close() }} isDismissable className="ai-sample-overlay">
    <Modal className={`ai-sample-modal ${className}`}><Dialog aria-label={title} className="ai-sample-dialog">
      <div className="ai-sample-dialog-heading"><h2>{title}</h2><Button variant="ghost" iconOnly leadingIcon={X} title={`关闭${title}`} aria-label={`关闭${title}`} onClick={close} /></div>
      {children}
    </Dialog></Modal>
  </ModalOverlay>
}

export function DesignPlayground() {
  const desktop = useMinWidth(768)
  const [stage, setStage] = useState<Stage>('welcome')
  const [view, setView] = useState<View>('chat')
  const [menu, setMenu] = useState(false)
  const [works, setWorks] = useState(false)
  const [viewer, setViewer] = useState<string | null>(null)
  const [clear, setClear] = useState(false)
  const [notice, setNotice] = useState('')
  const [favorite, setFavorite] = useState(false)
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')
  const [source, setSource] = useState('')
  const [plan, setPlan] = useState<Plan>(INITIAL_PLAN)
  const [editing, setEditing] = useState(false)
  const [reference, setReference] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ text: string; nonce: number }>()
  const [session, setSession] = useState(0)
  const [outcome, setOutcome] = useState<'done' | 'partial'>('done')
  const [referenceError, setReferenceError] = useState('')
  const [binding, setBinding] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const uploadButton = useRef<HTMLInputElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const bindingVersion = useRef(0)
  const hasConversation = stage !== 'welcome'
  const price = (plan.count * 0.3).toFixed(2)
  useEffect(() => () => { bindingVersion.current += 1 }, [])
  useEffect(() => {
    if (stage !== 'running') return
    const timer = window.setTimeout(() => setStage(outcome), 2200)
    return () => window.clearTimeout(timer)
  }, [stage, outcome])
  useEffect(() => {
    if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight
  }, [source])
  const focusComposer = () => window.requestAnimationFrame(() => textarea.current?.focus())
  const send = (text: string, upload?: Upload) => {
    setSource(text)
    if (upload) setReference(upload.dataUrl)
    setPlan({ ...INITIAL_PLAN, prompt: text, text: '', count: 1, useReference: Boolean(upload || reference) })
    setStage('plan'); setEditing(false); setNotice('')
  }
  const choose = (text: string) => {
    setDraft({ text, nonce: Date.now() }); setView('chat'); setMenu(false); focusComposer()
  }
  const selectStage = (next: Stage) => {
    if (next !== 'welcome' && !source) setSource('为一杯橙子汽水做一张清爽的夏日新品海报。')
    setView('chat'); setNotice(''); setEditing(false)
    if (next === 'partial') setPlan(p => ({ ...p, count: 2 }))
    setOutcome(next === 'partial' ? 'partial' : 'done'); setStage(next)
  }
  const bind = async (file: File) => {
    const version = ++bindingVersion.current
    setBinding(true); setReferenceError('')
    try { const image = await fileToDataUrl(file); if (version === bindingVersion.current) { setReference(image); setPlan(p => ({ ...p, useReference: true, count: 1 })) } }
    catch (error) { if (version === bindingVersion.current) setReferenceError(error instanceof Error ? error.message : '图片读取失败') }
    finally { if (version === bindingVersion.current) setBinding(false) }
  }
  const begin = () => { setOutcome('done'); setStage('running'); setNotice('') }
  const editResult = () => { setReference(viewer ?? orange); setViewer(null); choose('保留画面主体，帮我调整背景与配色。'); setNotice('已选中这张作品，下一条描述会用于修改它。') }
  const reset = () => {
    bindingVersion.current += 1; setBinding(false); setReferenceError(''); setStage('welcome'); setSource(''); setReference(null)
    setPlan(INITIAL_PLAN); setDraft(undefined); setNotice(''); setClear(false); setMenu(false); setView('chat'); setSession(n => n + 1)
  }
  const sidebar = <>
    <div className="ai-sample-brand"><img src={logo} alt="剑来生图" /><span>AI 创作工作台</span></div>
    <nav aria-label="主导航">
      <Button leadingIcon={SquarePen} variant="ghost" className="ai-sample-nav" aria-current={view === 'chat' ? 'page' : undefined} onClick={() => { setView('chat'); setMenu(false) }}>图片创作</Button>
      <Button leadingIcon={Images} variant="ghost" className="ai-sample-nav" aria-current={view === 'templates' ? 'page' : undefined} onClick={() => { setView('templates'); setMenu(false) }}>灵感模板</Button>
      <Button leadingIcon={Film} variant="ghost" className="ai-sample-nav" onClick={() => { setNotice('视频功能入口保留。本次交互样板聚焦图片创作。'); setMenu(false); setView('chat') }}>视频创作</Button>
      <div className="ai-sample-nav-divider" />
      <Button leadingIcon={Image} variant="ghost" className="ai-sample-nav" onClick={() => { setWorks(true); setMenu(false) }}>我的作品<span className="ai-sample-count">2</span></Button>
    </nav>
    <div className="ai-sample-sidebar-bottom"><p>从一句想法开始，<br />创作可以很简单。</p><div className="ai-sample-account"><img src={account} alt="" /><div><strong>共享账户</strong><span>演示余额 ¥20.00</span></div><Ellipsis aria-hidden="true" /></div></div>
  </>
  const artworks = <div className="ai-sample-works-content">
    <div className="ai-sample-filter" role="group" aria-label="作品筛选"><Button variant="ghost" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部作品</Button><Button variant="ghost" leadingIcon={Star} aria-pressed={filter === 'favorites'} onClick={() => setFilter('favorites')}>收藏</Button></div>
    <p className="ai-sample-quiet">示意作品</p>
    <div className="ai-sample-artwork-list">{(filter === 'favorites' && !favorite ? [] : [{ image: orange, title: '夏日新品海报', subtitle: '产品摄影 · 竖版' }, ...(filter === 'all' ? [{ image: architecture, title: '建筑空间练习', subtitle: '建筑摄影 · 方形' }] : [])]).map(art => <button key={art.title} className="ai-sample-artwork" onClick={() => setViewer(art.image)}><img src={art.image} alt={art.title} /><strong>{art.title}</strong><span>{art.subtitle}</span></button>)}</div>
    {filter === 'favorites' && !favorite ? <div className="ai-sample-works-empty"><Star aria-hidden="true" /><h3>留住喜欢的创作</h3><p>在作品上点击收藏，下次更容易找到。</p></div> : null}
  </div>
  const composer = <div className="ai-sample-composer-area">
    {reference ? <div className="ai-sample-reference"><img src={reference} alt="当前参考图" /><div><strong>参考图已就绪</strong><span>下一张将基于这张图片修改</span></div><Button variant="ghost" iconOnly leadingIcon={X} title="移除当前参考图" aria-label="移除当前参考图" onClick={() => { setReference(null); setPlan(p => ({ ...p, useReference: false })) }} /></div> : null}
    <Composer key={session} replying={false} usage={{ used: 0, limit: 50 }} editing={Boolean(reference)} onSend={send} onStop={() => {}} textareaRef={textarea} draft={draft} />
    <p className="ai-sample-composer-note">先整理方案，确认后才生成。此样板不会发起生成或扣费。</p>
  </div>
  return <div className="ai-sample-root">
    <div className="ai-sample-preview-bar"><span><span className="ai-sample-preview-dot" />交互样板<span className="ai-sample-preview-note"> · 不连接生成服务</span></span><label><span>查看状态</span><select aria-label="预览状态" value={stage} onChange={e => selectStage(e.target.value as Stage)}>{STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label></div>
    <div className="ai-sample-shell">
      <aside className="ai-sample-sidebar">{sidebar}</aside>
      <main className="ai-sample-main">
        <header className="ai-sample-topbar"><div className="ai-sample-topbar-title"><Button className="ai-sample-mobile-menu" variant="ghost" iconOnly leadingIcon={Menu} title="打开主菜单" aria-label="打开主菜单" onClick={() => setMenu(true)} /><span>{view === 'templates' ? '灵感模板' : '图片创作'}</span><ChevronDown aria-hidden="true" /></div><div className="ai-sample-topbar-actions"><Button variant="ghost" iconOnly leadingIcon={SquarePen} title="清空当前创作" aria-label="清空当前创作" disabled={!hasConversation} onClick={() => setClear(true)} /><Button variant="ghost" leadingIcon={Images} aria-expanded={works} aria-label="打开作品" onClick={() => setWorks(true)}>作品<span className="ai-sample-count">2</span></Button></div></header>
        {notice ? <div role="status" className="ai-sample-notice"><span>{notice}</span><Button variant="ghost" iconOnly leadingIcon={X} title="关闭提示" aria-label="关闭提示" onClick={() => setNotice('')} /></div> : null}
        {view === 'templates' ? <section className="ai-sample-templates"><span className="ai-sample-eyebrow">灵感从这里开始</span><h1>给创作一个起点。</h1><p>选择一个示意模板，改成你的想法。</p><div className="ai-sample-template-grid">{EXAMPLES.map(({ title, detail, text, Icon }) => <button key={title} onClick={() => choose(text)}><Icon aria-hidden="true" /><h2>{title}</h2><p>{detail}</p><ArrowUpRight aria-hidden="true" /></button>)}</div></section> : <>
          {!hasConversation ? <section className="ai-sample-welcome"><div className="ai-sample-welcome-inner"><span className="ai-sample-eyebrow">剑来 · 让创意自然发生</span><h1>把想法，变成画面。</h1><p className="ai-sample-intro">描述想象，或上传一张图。剩下的，我们一起完成。</p>{composer}<div className="ai-sample-suggestions" aria-label="创作灵感">{EXAMPLES.map(({ title, detail, Icon, text }) => <button key={title} onClick={() => choose(text)}><Icon aria-hidden="true" /><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight aria-hidden="true" /></button>)}</div></div></section> : <>
            <div className="ai-sample-timeline" ref={timeline}><div className="ai-sample-conversation"><div className="ai-sample-user-message">{source}</div><article className="ai-sample-assistant"><div className="ai-sample-assistant-name"><span className="ai-sample-assistant-mark"><Plus aria-hidden="true" /></span><strong>剑来</strong><span>创作助手</span></div><p className="ai-sample-assistant-copy">{stage === 'plan' ? '我整理好了画面方向。可以先调整描述与参数，确认后再生成。' : '沿着这个方向，继续把想法打磨成你喜欢的样子。'}</p>
              {stage === 'plan' ? <section className="ai-sample-plan" aria-label="生成方案"><div className="ai-sample-plan-heading"><div><Image aria-hidden="true" /><h2>生成方案</h2></div><span>待你确认</span></div><div className="ai-sample-plan-description"><div className="ai-sample-field-heading"><label htmlFor={editing ? 'ai-sample-description' : undefined}>画面描述</label><Button variant="ghost" leadingIcon={Pencil} onClick={() => setEditing(!editing)}>{editing ? '完成编辑' : '编辑描述'}</Button></div>{editing ? <textarea id="ai-sample-description" aria-label="画面描述" value={plan.prompt} onChange={e => setPlan({ ...plan, prompt: e.target.value })} rows={3} maxLength={2000} /> : <p>{plan.prompt}</p>}</div>
                <div className="ai-sample-plan-controls"><label>画幅<select aria-label="画幅" value={plan.size} onChange={e => setPlan({ ...plan, size: e.target.value })}><option value="1024x1536">2:3 竖版</option><option value="1536x1024">3:2 横版</option><option value="1024x1024">1:1 方形</option></select></label><label>质量<select aria-label="质量" value={plan.quality} onChange={e => setPlan({ ...plan, quality: e.target.value })}><option value="medium">精细</option><option value="high">高品质</option></select></label><label>数量<select aria-label="数量" value={plan.count} disabled={plan.useReference} onChange={e => setPlan({ ...plan, count: Number(e.target.value) as 1 | 2 })}><option value="1">1 张</option><option value="2">2 张</option></select></label></div>
                <details className="ai-sample-extra"><summary>画面文字与参考图</summary><label>画面文字（可选）<input aria-label="画面文字" value={plan.text} onChange={e => setPlan({ ...plan, text: e.target.value })} /></label><input hidden type="file" accept="image/png,image/jpeg,image/webp" ref={uploadButton} aria-label="方案参考图" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void bind(file) }} /><Button variant="secondary" leadingIcon={Plus} disabled={binding} onClick={() => uploadButton.current?.click()}>{binding ? '正在校验…' : reference ? '更换参考图' : '添加参考图'}</Button>{referenceError ? <p role="alert">{referenceError}</p> : null}</details>
                <footer className="ai-sample-plan-footer"><div><span>预计费用</span><strong>¥{price}</strong><small>成功交付才扣费</small></div><Button onClick={begin} disabled={!plan.prompt.trim() || binding} leadingIcon={ArrowUpRight}>确认并生成</Button></footer></section> : null}
              {stage === 'running' ? <section className="ai-sample-generating" aria-label="生成状态"><div className="ai-sample-result-placeholder"><Image aria-hidden="true" /><span>正在生成你的画面</span><small>演示生成过程，作品即将呈现</small></div><div className="ai-sample-generating-footer"><span role="status"><span className="ai-sample-live-dot" />模拟生成中</span><Button variant="ghost" onClick={() => setStage('unknown')}>停止等待</Button></div></section> : null}
              {stage === 'unknown' || stage === 'failed' ? <section className="ai-sample-recovery" role="alert"><h2>{stage === 'unknown' ? '已停止本地等待' : '这次没有生成成功'}</h2><p>{stage === 'unknown' ? '停止等待不等于取消任务。最终结果和费用仍待确认，请继续查询原任务。' : '服务端已确认任务失败，未扣费。你可以调整方案后重新生成。'}</p><div><Button variant="secondary" onClick={begin}>{stage === 'unknown' ? '继续查询原任务' : '按原方案重新生成'}</Button>{stage === 'failed' ? <Button variant="ghost" onClick={() => setStage('plan')}>查看方案</Button> : null}</div></section> : null}
              {stage === 'done' || stage === 'partial' ? <section className="ai-sample-result" aria-label="生成结果"><div className="ai-sample-result-summary"><CheckCheck aria-hidden="true" /><span>{stage === 'partial' ? '部分成功 · 已交付 1 / 2 张' : `已完成 · ${plan.count} 张示意作品`}</span><span>示意费用 ¥{stage === 'partial' ? '0.30' : price}</span></div><div className={`ai-sample-result-images ${stage === 'done' && plan.count === 2 ? 'ai-sample-result-pair' : ''}`}>{Array.from({ length: stage === 'partial' ? 1 : plan.count }, (_, i) => <button key={i} className="ai-sample-result-image" aria-label={`放大查看作品 ${i + 1}`} onClick={() => setViewer(orange)}><img src={orange} alt="橙子汽水夏日海报示意作品" /></button>)}</div><div className="ai-sample-result-actions"><Button variant="secondary" leadingIcon={Pencil} onClick={editResult}>继续修改</Button><Button variant="ghost" iconOnly leadingIcon={Star} title={favorite ? '取消收藏' : '收藏作品'} aria-label={favorite ? '取消收藏' : '收藏作品'} aria-pressed={favorite} onClick={() => setFavorite(!favorite)} /><a href={orange} download="剑来-示意海报.webp" title="下载示意作品" aria-label="下载示意作品"><ArrowDownToLine aria-hidden="true" /></a></div>{stage === 'partial' ? <p className="ai-sample-partial-note">另 1 张未交付，不计费。需要补生成时，请重新确认方案和费用。</p> : null}</section> : null}
              {stage === 'done' || stage === 'partial' || stage === 'failed' ? <button className="ai-sample-plan-reopen" onClick={() => setStage('plan')}><Check aria-hidden="true" />查看生成方案<span>{plan.size === '1024x1536' ? '2:3 竖版' : plan.size === '1536x1024' ? '3:2 横版' : '1:1 方形'} · {plan.count} 张</span></button> : null}
            </article></div></div><div className="ai-sample-footer-composer">{composer}</div>
          </>}
        </>}
      </main>
      {works && desktop ? <aside className="ai-sample-works-desktop"><header><h2>我的作品</h2><Button variant="ghost" iconOnly leadingIcon={PanelRightClose} title="收起作品" aria-label="收起作品" onClick={() => setWorks(false)} /></header>{artworks}</aside> : null}
    </div>
    <Surface title="主菜单" open={menu} close={() => setMenu(false)} className="ai-sample-menu-modal">{sidebar}<Button className="ai-sample-menu-close" variant="ghost" leadingIcon={PanelLeftClose} onClick={() => setMenu(false)}>收起菜单</Button></Surface>
    <Surface title="作品" open={works && !desktop} close={() => setWorks(false)} className="ai-sample-works-modal">{artworks}</Surface>
    <Surface title="查看作品" open={Boolean(viewer)} close={() => setViewer(null)} className="ai-sample-viewer-modal"><img className="ai-sample-viewer-image" src={viewer ?? undefined} alt="放大的示意作品" /><div className="ai-sample-viewer-actions"><Button leadingIcon={Pencil} onClick={editResult}>继续修改</Button><a href={viewer ?? undefined} download="剑来-示意作品.webp">下载示意作品</a></div></Surface>
    <Surface title="清空当前创作" open={clear} close={() => setClear(false)} className="ai-sample-confirm-modal"><p>清空当前页面的创作内容？作品不会删除。</p><div className="ai-sample-confirm-actions"><Button variant="secondary" onClick={() => setClear(false)}>保留创作</Button><Button variant="danger" onClick={reset}>清空创作</Button></div></Surface>
  </div>
}
