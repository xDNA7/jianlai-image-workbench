import { ChevronRightIcon, ChevronsLeftIcon, ImageIcon, StarIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { SegmentedControl, SegmentedControlItem } from '@/boardui/segmented-control'
import { isFavoriteImage } from './store'
import type { GalleryRecord } from './types'
import './navigation.css'

type Props = {
  records: GalleryRecord[]
  state: 'loading' | 'ready' | 'error'
  favorites: string[]
  filter: 'all' | 'favorites'
  onFilter: (value: 'all' | 'favorites') => void
  onOpen: (record: GalleryRecord) => void
  onRetry: () => void
  onCollapse?: () => void
  freshAfter: number
}

export function groupByDay(records: GalleryRecord[], now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const today = records.filter((r) => r.created >= start)
  const earlier = records.filter((r) => r.created < start)
  return [
    { label: '今天', items: today },
    { label: '更早', items: earlier },
  ].filter((g) => g.items.length > 0)
}

export function GalleryPanel(p: Props) {
  const shown = p.filter === 'favorites' ? p.records.filter((r) => isFavoriteImage(p.favorites, r)) : p.records
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
          if (value === 'all' || value === 'favorites') p.onFilter(value)
        }}
        className="jl-gallery-filter w-fit"
      >
        <SegmentedControlItem id="all">全部</SegmentedControlItem>
        <SegmentedControlItem id="favorites">收藏</SegmentedControlItem>
      </SegmentedControl>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {p.state === 'loading' ? (
          <div className="grid grid-cols-2 gap-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="chat-skeleton relative aspect-square rounded-lg bg-muted" />)}
          </div>
        ) : p.state === 'error' ? (
          <div role="alert" className="grid justify-items-start gap-2 text-sm text-muted-foreground">
            <span>画廊加载失败</span>
            <Button variant="secondary" size="small" onClick={p.onRetry}>重试</Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="grid justify-items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <ImageIcon aria-hidden="true" className="size-8 opacity-50" />
            {p.filter === 'favorites' ? '还没有收藏的作品' : '生成的图片会出现在这里'}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-6" aria-label={group.label}>
              <h3 className="mb-3 text-sm leading-5 font-medium text-muted-foreground">{group.label}</h3>
              <div className="grid grid-cols-2 gap-3">
                {group.items.map((r) => {
                  const fresh = r.created >= p.freshAfter
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => p.onOpen(r)}
                      aria-label={`查看作品：${r.prompt.slice(0, 30) || '未命名'}`}
                      className={`relative aspect-square overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${fresh ? 'ring-2 ring-primary' : ''}`}
                    >
                      <span className="absolute inset-0 grid place-items-center" aria-hidden="true"><ImageIcon className="size-8 text-muted-foreground/40" /></span>
                      <img src={r.preview} alt="" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.hidden = true }} className="relative size-full object-cover" />
                      {isFavoriteImage(p.favorites, r) ? (
                        <StarIcon aria-label="已收藏" className="absolute top-2 right-2 size-5 fill-amber-400 text-amber-400 drop-shadow" />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
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
