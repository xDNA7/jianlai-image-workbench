import { ChevronRightIcon, ChevronsLeftIcon, FilmIcon, ImageIcon, PlayIcon, StarIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { SegmentedControl, SegmentedControlItem } from '@/boardui/segmented-control'
import { isFavoriteImage } from './store'
import type { GalleryRecord } from './types'
import { filterGallery, galleryMedia, type GalleryFilter, type GalleryMedia, type GalleryVideo } from './media-gallery'
import './navigation.css'

type Props = {
  records: GalleryRecord[]
  state: 'loading' | 'ready' | 'error'
  favorites: string[]
  filter: GalleryFilter
  onFilter: (value: GalleryFilter) => void
  videos?: GalleryVideo[]
  videoState?: 'idle' | 'loading' | 'ready' | 'error'
  onOpenVideo?: (record: GalleryVideo) => void
  onOpen: (record: GalleryRecord) => void
  onRetry: () => void
  onCollapse?: () => void
  freshAfter: number
}

export function groupByDay<T extends { created: number }>(records: T[], now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const today = records.filter((r) => r.created >= start)
  const earlier = records.filter((r) => r.created < start)
  return [
    { label: '今天', items: today },
    { label: '更早', items: earlier },
  ].filter((g) => g.items.length > 0)
}

export function GalleryPanel(p: Props) {
  const shown = filterGallery(galleryMedia(p.records, p.videos || []), p.filter, p.favorites)
  const loadingVideos = p.videoState === 'loading' && (p.filter === 'all' || p.filter === 'videos')
  const emptyMessage = p.filter === 'favorites' ? '还没有收藏的图片' : p.filter === 'images' ? '生成的图片会出现在这里' : p.filter === 'videos' ? '生成的视频会出现在这里' : '生成的图片和视频会出现在这里'
  const groups = groupByDay(shown)
  return (
    <div className="jl-gallery-content flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl leading-7 font-semibold">我的作品</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">每次创作，都在这里</p>
        </div>
        {p.onCollapse ? (
          <Button variant="ghost" size="small" iconOnly leadingIcon={ChevronsLeftIcon} aria-label="收起画廊" title="收起画廊" onClick={p.onCollapse} className="rotate-180" />
        ) : null}
      </div>
      <SegmentedControl
        aria-label="画廊筛选"
        selectedKeys={[p.filter]}
        onSelectionChange={(keys) => {
          const value = [...keys][0]
          if (value === 'all' || value === 'images' || value === 'videos' || value === 'favorites') p.onFilter(value)
        }}
        className="jl-gallery-filter w-full min-w-0"
      >
        <SegmentedControlItem className="min-w-0! flex-1 px-2!" id="all">全部</SegmentedControlItem>
        <SegmentedControlItem className="min-w-0! flex-1 px-2!" id="images">图片</SegmentedControlItem>
        <SegmentedControlItem className="min-w-0! flex-1 px-2!" id="videos">视频</SegmentedControlItem>
        <SegmentedControlItem className="min-w-0! flex-1 px-2!" id="favorites">收藏</SegmentedControlItem>
      </SegmentedControl>
      {p.state === 'error' && p.filter !== 'videos' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>画廊加载失败</span><Button variant="secondary" size="small" onClick={p.onRetry}>重试</Button>
        </div>
      ) : null}
      {p.videoState === 'error' && (p.filter === 'all' || p.filter === 'videos') ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>视频作品加载失败</span><Button variant="secondary" size="small" onClick={p.onRetry}>重试视频作品</Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {!shown.length && ((p.state === 'loading' && p.filter !== 'videos') || loadingVideos) ? (
          <div className="grid grid-cols-2 gap-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="chat-skeleton relative aspect-square rounded-lg bg-muted" />)}
          </div>
        ) : groups.length === 0 ? (
          <div className="grid justify-items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <ImageIcon aria-hidden="true" className="size-8 opacity-50" />
            {emptyMessage}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-6" aria-label={group.label}>
              <h3 className="mb-3 text-sm leading-5 font-medium text-muted-foreground">{group.label}</h3>
              <div className="grid grid-cols-2 gap-3">
                {group.items.map((r) => <MediaTile key={`${r.kind}:${r.id}`} record={r} freshAfter={p.freshAfter} favorites={p.favorites} onOpen={p.onOpen} onOpenVideo={p.onOpenVideo} />)}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function MediaTile({ record: r, freshAfter, favorites, onOpen, onOpenVideo }: {
  record: GalleryMedia
  freshAfter: number
  favorites: string[]
  onOpen: (record: GalleryRecord) => void
  onOpenVideo?: (record: GalleryVideo) => void
}) {
  const fresh = r.created >= freshAfter
  return <button
    type="button"
    onClick={() => r.kind === 'image' ? onOpen(r.image) : onOpenVideo?.(r)}
    aria-label={`${r.kind === 'video' ? '查看视频' : '查看作品'}：${r.prompt.slice(0, 30) || '未命名'}`}
    className={`relative aspect-square overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${fresh ? 'ring-2 ring-primary' : ''}`}
  >
    {r.kind === 'image' ? <>
      <span className="absolute inset-0 grid place-items-center" aria-hidden="true"><ImageIcon className="size-8 text-muted-foreground/40" /></span>
      <img src={r.image.preview} alt="" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.hidden = true }} className="relative size-full object-cover" />
      {isFavoriteImage(favorites, r.image) ? <StarIcon aria-label="已收藏" className="absolute top-2 right-2 size-5 fill-amber-400 text-amber-400 drop-shadow" /> : null}
    </> : <>
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2" aria-hidden="true">
        <FilmIcon className="size-9 text-muted-foreground/60" />
        <span className="max-w-full px-3 text-xs text-muted-foreground line-clamp-2">{r.prompt}</span>
      </span>
      <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-xs"><PlayIcon className="size-3" aria-hidden="true" />视频{r.duration != null ? ` · ${r.duration}s` : ''}</span>
      {!r.url ? <span className="absolute top-2 left-2 rounded-md bg-background/90 px-1.5 py-0.5 text-xs text-muted-foreground">链接待更新</span> : null}
    </>}
  </button>
}

export function GalleryRail({ records, onExpand, onOpen }: { records: GalleryRecord[]; onExpand: () => void; onOpen: (r: GalleryRecord) => void }) {
  return (
    <div className="flex h-full flex-col items-center gap-3">
      <Button variant="ghost" size="small" iconOnly leadingIcon={ChevronRightIcon} aria-label="展开画廊" title="展开画廊" onClick={onExpand} className="rotate-180" />
      <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-hidden">
        {records.slice(0, 8).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            aria-label="查看作品"
            className="size-11 shrink-0 overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <img src={r.preview} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  )
}
