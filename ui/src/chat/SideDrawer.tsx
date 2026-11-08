import { useEffect, useRef, useState } from 'react'
import { Heading, Text } from 'react-aria-components'
import { motion, useMotionValue } from 'motion/react'
import { Modal } from '@/boardui/modal'

/** True when the viewport is at least `px` wide. Defaults to desktop on the server. */
export function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  side: 'left' | 'right'
  title: string
  children: React.ReactNode
}

export function SideDrawer({ open, onOpenChange, side, title, children }: Props) {
  const left = side === 'left'
  const x = useMotionValue(0)
  const gesture = useRef<{ x: number; y: number; id: number } | null>(null)
  useEffect(() => { if (!open) { x.set(0); gesture.current = null } }, [open, x])
  return <Modal open={open} onOpenChange={onOpenChange} label={`${title}面板`} backdropClassName="bg-black/25"
    className={`fixed inset-y-0 ${left ? 'left-0' : 'right-0'} w-[min(20rem,88vw)] outline-none`}>
    <motion.div className="jl-drawer flex h-full flex-col overflow-y-auto overscroll-contain bg-background p-4 shadow-xl" style={{ x, touchAction: 'pan-y pinch-zoom' }}
      onPointerDown={e => {
        if (e.pointerType !== 'touch' || (e.target as Element).closest('button,a,input,textarea,select')) return
        gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
      }}
      onPointerMove={e => {
        const g = gesture.current
        if (!g || g.id !== e.pointerId) return
        const dx = e.clientX - g.x, dy = e.clientY - g.y
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { gesture.current = null; x.set(0); return }
        const outward = left ? Math.min(0, dx) : Math.max(0, dx)
        if (Math.abs(outward) > 10) { e.currentTarget.setPointerCapture(e.pointerId); x.set(outward) }
      }}
      onPointerUp={e => {
        if (gesture.current?.id !== e.pointerId) return
        const dismissed = Math.abs(x.get()) >= 80
        gesture.current = null
        x.set(0)
        if (dismissed) onOpenChange(false)
      }}
      onPointerCancel={() => { gesture.current = null; x.set(0) }}>
      <Heading slot="title" className="sr-only">{title}面板</Heading>
      <Text slot="description" className="sr-only">从屏幕边缘滑出的{title}</Text>
      {children}
    </motion.div>
  </Modal>
}
