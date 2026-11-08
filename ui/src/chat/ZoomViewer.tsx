import { useRef, useState } from 'react'
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react'
import { Button } from '@/boardui/button'

/** 0 means "fit to the window"; the others are multiples of the original's pixel size. */
export const ZOOM_LEVELS = [0, 1, 2, 4] as const

export function nextZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_LEVELS.indexOf(current as (typeof ZOOM_LEVELS)[number])
  const at = i < 0 ? 0 : i
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, at + direction))]
}

type Props = { preview: string; original: string; alt: string }

/**
 * Shows the preview fitted to the window. Zooming loads the original and
 * shows it at real pixel size (or 2x / 4x), scrollable and draggable.
 */
export function ZoomViewer({ preview, original, alt }: Props) {
  const [zoom, setZoom] = useState(0)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)

  const ensureOriginal = () => {
    if (state === 'ready' || state === 'loading') return
    setState('loading')
    const img = new Image()
    img.onload = () => {
      setSize({ w: img.naturalWidth, h: img.naturalHeight })
      setState('ready')
    }
    img.onerror = () => setState('failed')
    img.src = original
  }
  const change = (next: number) => {
    if (next > 0) ensureOriginal()
    setZoom(next)
    box.current?.scrollTo({ left: 0, top: 0 })
  }

  const zoomed = zoom > 0 && state === 'ready' && size
  return (
    <div className="grid min-h-0 gap-2">
      <div
        ref={box}
        data-testid="zoom-box"
        className={`flex max-h-[62dvh] min-h-0 overflow-auto overscroll-contain rounded-xl bg-muted ${zoomed ? 'cursor-grab active:cursor-grabbing' : 'justify-center'}`}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse' || e.button !== 0 || !zoomed || !box.current) return
          drag.current = { x: e.clientX, y: e.clientY, left: box.current.scrollLeft, top: box.current.scrollTop, moved: false }
          box.current.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || !box.current) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
          box.current.scrollLeft = d.left - dx
          box.current.scrollTop = d.top - dy
        }}
        onPointerUp={() => {
          justDragged.current = Boolean(drag.current?.moved)
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {zoomed ? (
          <img
            src={original}
            alt={alt}
            draggable={false}
            data-testid="zoom-image"
            className="m-auto max-w-none shrink-0 select-none"
            style={{ width: size.w * zoom, height: size.h * zoom }}
            onClick={() => {
              if (justDragged.current) {
                justDragged.current = false
                return
              }
              change(0)
            }}
          />
        ) : (
          <img
            src={preview}
            alt={alt}
            data-testid="zoom-image"
            className="block max-h-[62dvh] w-auto max-w-full cursor-zoom-in object-contain"
            onClick={() => change(1)}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button variant="secondary" size="small" aria-label="缩小" disabled={zoom === 0} onClick={() => change(nextZoom(zoom, -1))} leadingIcon={ZoomOutIcon}>缩小</Button>
        <Button variant="secondary" size="small" aria-label="放大看细节" disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} onClick={() => change(nextZoom(zoom, 1))} leadingIcon={ZoomInIcon}>放大</Button>
        <Button variant="ghost" size="small" aria-label="适应屏幕" disabled={zoom === 0} onClick={() => change(0)} leadingIcon={MaximizeIcon}>适应屏幕</Button>
        <span role="status" className="text-xs text-muted-foreground">
          {state === 'loading' && zoom > 0
            ? '正在加载原图…'
            : state === 'failed' && zoom > 0
              ? '原图加载失败，仍显示预览'
              : zoom === 0
                ? '点图片可放大看细节'
                : `${zoom * 100}% · 原图 ${size?.w}×${size?.h}`}
        </span>
      </div>
    </div>
  )
}
