import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { MotionConfig } from 'motion/react'
import { ImagesIcon, MenuIcon, PencilIcon, XIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { ChatThread } from './ChatThread'
import { AnnotateDialog } from './AnnotateDialog'
import type { AnnotateTarget } from './AnnotateDialog'
import { Composer } from './Composer'
import { GalleryPanel } from './Gallery'
import { VideoLightbox } from './VideoLightbox'
import type { GalleryFilter, GalleryVideo } from './media-gallery'
import { Lightbox } from './Lightbox'
import type { LightboxImage } from './Lightbox'
import { isFavoriteImage } from './store'
import { Sidebar } from './Sidebar'
import type { View } from './Sidebar'
import { SideDrawer, useMinWidth } from './SideDrawer'
import { TemplatesPane } from './TemplatesPane'
import type { ThreadActions } from './Thread'
import { jobImageReferenceUrl } from './api'
import { normalizeAnimation, recommendAnimation } from './animation'
import type { AnimationMetadata, AnimationPlan } from './types'
import type { Template } from './types'
import type { Mark } from './marks'
import { useWorkbench } from './useWorkbench'
import { VideoAccessGate } from './VideoAccessGate'
import './chat.css'

const VideoPane = lazy(() => import('./VideoPane'))

function initialView(search: string | undefined): View {
  return search === 'video' ? 'video' : search === 'templates' ? 'templates' : 'chat'
}

export function ChatApp() {
  const w = useWorkbench()
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('chat-theme')
    const visibility = () => { root.dataset.jlHidden = String(document.hidden) }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => { root.classList.remove('chat-theme'); delete root.dataset.jlHidden; document.removeEventListener('visibilitychange', visibility) }
  }, [])
  const search = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('view') ?? undefined
  const desktop = useMinWidth(768)
  const [view, setView] = useState<View>(() => initialView(search))
  const { ensureTemplates, templatesState } = w
  useEffect(() => {
    if (view === 'templates' && templatesState === 'idle') void ensureTemplates()
  }, [view, templatesState, ensureTemplates])
  const [menuOpen, setMenuOpen] = useState(false)
  const [galleryDrawer, setGalleryDrawer] = useState(false)
  const [filter, setFilter] = useState<GalleryFilter>('all')
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null)
  const [videoSelection, setVideoSelection] = useState<{ accountId: string | null; video: GalleryVideo } | null>(null)
  useEffect(() => {
    if (!w.videoAccess.authenticated) setVideoSelection(null)
  }, [w.videoAccess.authenticated])
  const videoLightbox = w.videoAccess.authenticated && videoSelection?.accountId === (w.boot?.accountId ?? null) ? videoSelection.video : null
  const [composerEpoch, setComposerEpoch] = useState(0)
  const [draft, setDraft] = useState<{ text: string; nonce: number }>()
  const [annotating, setAnnotating] = useState<AnnotateTarget | null>(null)
  const sessionStart = useRef(Date.now())
  const textarea = useRef<HTMLTextAreaElement>(null)
  const show = (to: View) => {
    setView(to)
    setMenuOpen(false)
  }
  const pickTemplate = (t: Template) => {
    w.unpin()
    setDraft({ text: t.text ? `${t.prompt}\n画面文字：「${t.text}」` : t.prompt, nonce: Date.now() })
    show('chat')
    setTimeout(() => textarea.current?.focus(), 50)
  }
  // "修改这张图" opens the mark editor first; confirming brings the image (and
  // its marks) into the conversation as the reference for the next message.
  const startEdit = (image: { download: string; preview: string; prompt: string; jobId?: string; index?: number; type?: string; animation?: AnimationMetadata; animationPlan?: AnimationPlan }, marks: Mark[] = []) => {
    setLightbox(null)
    setGalleryDrawer(false)
    const animation = image.animationPlan ?? (image.type === 'image/gif' || /\.gif(?:[?#]|$)/i.test(image.download)
      ? image.animation ? normalizeAnimation({ fps: image.animation.fps, durationSeconds: image.animation.durationMs / 1000 }, 'GIF') : recommendAnimation('GIF') : undefined)
    setAnnotating({ url: image.jobId != null && image.index != null ? jobImageReferenceUrl(image.jobId, image.index) : image.download, preview: image.preview, prompt: image.prompt, marks, animation })
  }
  const confirmEdit = (target: AnnotateTarget, marks: Mark[]) => {
    w.pin({ download: target.url, preview: target.preview, prompt: target.prompt, animation: target.animation }, marks)
    setAnnotating(null)
    show('chat')
    setTimeout(() => textarea.current?.focus(), 50)
  }
  const caps = w.boot?.capabilities
  const actions: ThreadActions | null = caps
    ? {
        caps,
        balance: w.balance,
        busy: w.busy,
        limitReached: w.usage.used >= w.usage.limit,
        sessionStart: sessionStart.current,
        onChangePlan: w.updatePlan,
        onConfirm: w.confirmPlan,
        onRebindReference: w.rebindReference,
        onUploadReference: w.uploadPersonReference,
        onDismiss: (id) => {
          w.dismissPlan(id)
          textarea.current?.focus()
        },
        onGenerateAsWritten: w.generateAsWritten,
        onStop: w.stopWaiting,
        onRetryPoll: w.retryPolling,
        onRetryGeneration: w.retryGeneration,
        onOpen: (image) => setLightbox(image),
        onEdit: (image) => startEdit(image),
      }
    : null
  const gallery = (
    <GalleryPanel
      records={w.gallery}
      videos={w.videoGallery}
      videoState={w.videoGalleryState}
      onOpenVideo={video => setVideoSelection({ accountId: w.boot?.accountId ?? null, video })}
      state={w.galleryState}
      favorites={w.favorites}
      filter={filter}
      onFilter={setFilter}
      onOpen={setLightbox}
      onRetry={w.refreshGallery}
      onCollapse={() => setGalleryDrawer(false)}
      freshAfter={sessionStart.current}
    />
  )
  const sidebar = (
    <Sidebar
      view={view}
      balance={w.balance}
      hasThread={w.items.length > 0}
      onView={show}
      onClear={() => {
        w.clearAll()
        setDraft(undefined)
        setComposerEpoch(epoch => epoch + 1)
        setAnnotating(null)
        setMenuOpen(false)
      }}
    />
  )
  if (w.bootError) {
    return (
      <div role="alert" className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="grid justify-items-center gap-3">
          <p>{w.bootError}</p>
          <Button onClick={() => window.location.reload()}>刷新重试</Button>
        </div>
      </div>
    )
  }
  if (!w.ready || !actions) {
    return <div className="grid min-h-dvh place-items-center text-sm text-muted-foreground" aria-busy="true">正在准备工作台…</div>
  }
  const current = lightbox
  const composer = (
    <div className="jl-composer-shell">
      {w.pinned ? (
        <div className="jl-pin">
          <img src={w.pinned.preview} alt="当前参考图" className="size-10 shrink-0 rounded-md object-cover" />
          <span className="min-w-0 flex-1">{w.pinned.animation ? '使用 GIF 首帧作为参考，重新生成动图' : '下一条会修改这张图'}{w.pinned.marks.length ? `，已标记 ${w.pinned.marks.length} 处` : ''}</span>
          <Button variant="secondary" size="xs" onClick={() => startEdit({ download: w.pinned!.url, preview: w.pinned!.preview, prompt: w.pinned!.prompt, animationPlan: w.pinned!.animation }, w.pinned!.marks)} leadingIcon={PencilIcon}>{w.pinned.marks.length ? '重新标记' : '标记位置'}</Button>
          <Button variant="ghost" size="xs" iconOnly leadingIcon={XIcon} aria-label="取消指定参考图" onClick={w.unpin} />
        </div>
      ) : null}
      <Composer key={composerEpoch} onPickReference={w.unpin} replying={w.replying} usage={w.usage} editing={w.pinned != null} canSendEmpty={(w.pinned?.marks.length ?? 0) > 0} onSend={(text, upload) => { setDraft(undefined); void w.send(text, upload) }} onStop={w.stopReplying} textareaRef={textarea} draft={draft} />
      <p className="jl-composer-caption">先整理方案，确认后再生成。上传图片，也可以继续修改。</p>
    </div>
  )
  const titles: Record<View, string> = { chat: '图片创作', templates: '灵感模板', video: '视频创作' }
  return (
    <MotionConfig reducedMotion="user">
      <div className="jl-workbench">
        {desktop ? <aside className="jl-sidebar">{sidebar}</aside> : null}
        <main className="jl-main">
          <header className="jl-topbar">
            <div className="jl-topbar-title">
              {!desktop ? <Button variant="ghost" iconOnly leadingIcon={MenuIcon} aria-label="打开菜单" onClick={() => setMenuOpen(true)} /> : null}
              <span>{titles[view]}</span>
            </div>
            <Button variant="ghost" leadingIcon={ImagesIcon} aria-label="打开画廊" aria-expanded={galleryDrawer} onClick={() => { w.ensureGallery(); setGalleryDrawer(true) }}>作品<span className="jl-artwork-count">{w.gallery.length + w.videoGallery.length}</span></Button>
          </header>
          {view === 'chat' ? (
            <>
              <div className="jl-thread-area">
                <ChatThread items={w.items} actions={actions} disabled={w.replying} onSuggest={(text) => void w.send(text)} emptyComposer={composer} />
              </div>
              {w.items.length ? composer : null}
            </>
          ) : view === 'templates' ? (
            <div className="jl-pane-scroll"><TemplatesPane templates={w.templates} mine={w.mine} onRemoveMine={w.removeMine} state={w.templatesState} onRetry={w.ensureTemplates} onPick={pickTemplate} /></div>
          ) : (
            <div className="jl-pane-scroll"><VideoAccessGate access={w.videoAccess}><Suspense fallback={<p className="p-6 text-sm text-muted-foreground">加载中…</p>}><VideoPane key={w.boot?.accountId || 'pending'} accountId={w.boot?.accountId || null} balance={w.balance} onBalance={w.refreshBalance} /></Suspense></VideoAccessGate></div>
          )}
        </main>
      </div>
      <SideDrawer open={!desktop && menuOpen} onOpenChange={setMenuOpen} side="left" title="菜单">{sidebar}</SideDrawer>
      <SideDrawer open={galleryDrawer} onOpenChange={setGalleryDrawer} side="right" title="画廊">{gallery}</SideDrawer>
      {videoLightbox ? <VideoLightbox key={`${w.boot?.accountId}:${videoLightbox.id}`} video={videoLightbox} onClose={() => setVideoSelection(null)} /> : null}
      <AnnotateDialog target={annotating} onCancel={() => setAnnotating(null)} onConfirm={confirmEdit} />
      <Lightbox image={current} favorite={current ? isFavoriteImage(w.favorites, current) : false} onClose={() => setLightbox(null)} onFavorite={w.toggleFavorite} onSaveTemplate={w.saveMine} onContinue={(image) => startEdit(image)} onDelete={w.deleteImage} />
    </MotionConfig>
  )
}
