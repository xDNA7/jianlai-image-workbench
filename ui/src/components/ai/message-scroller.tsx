import { createContext, useContext, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { ArrowDownIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { cn } from '@/lib/utils'

type ScrollState = {
  viewport: RefObject<HTMLDivElement | null>
  follow: RefObject<boolean>
  atEnd: boolean
  setAtEnd: (value: boolean) => void
  autoScroll: boolean
}
const ScrollContext = createContext<ScrollState | null>(null)
function useScroll() {
  const value = useContext(ScrollContext)
  if (!value) throw new Error('MessageScroller requires its provider')
  return value
}
export function MessageScrollerProvider({ children, autoScroll = true }: { children: ReactNode; autoScroll?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  return <ScrollContext.Provider value={{ viewport, follow, atEnd, setAtEnd, autoScroll }}>{children}</ScrollContext.Provider>
}
export function MessageScroller({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="message-scroller" className={cn('relative flex size-full min-h-0 flex-col overflow-hidden', className)} {...props} />
}
export function MessageScrollerViewport({ className, onScroll, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { viewport, follow, setAtEnd } = useScroll()
  return <div ref={viewport} data-slot="message-scroller-viewport" className={cn('size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain scrollbar-gutter-stable', className)} {...props} onScroll={e => {
    const v = e.currentTarget
    const end = v.scrollHeight - v.clientHeight - v.scrollTop < 48
    follow.current = end
    setAtEnd(end)
    onScroll?.(e)
  }} />
}
export function MessageScrollerContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const content = useRef<HTMLDivElement>(null)
  const { viewport, follow, autoScroll } = useScroll()
  useEffect(() => {
    const target = content.current
    if (!target) return
    const update = () => { if (autoScroll && follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }
    const observer = new ResizeObserver(update)
    observer.observe(target)
    update()
    return () => observer.disconnect()
  }, [viewport, follow, autoScroll])
  return <div ref={content} data-slot="message-scroller-content" className={cn('flex h-max min-h-full flex-col gap-6', className)} {...props} />
}
export function MessageScrollerItem({ className, messageId, scrollAnchor, ...props }: HTMLAttributes<HTMLDivElement> & { messageId?: string; scrollAnchor?: boolean }) {
  const { viewport, follow } = useScroll()
  useEffect(() => {
    if (scrollAnchor && viewport.current) { follow.current = true; viewport.current.scrollTop = viewport.current.scrollHeight }
  }, [messageId, scrollAnchor, viewport, follow])
  return <div data-slot="message-scroller-item" data-message-id={messageId} className={cn('min-w-0 shrink-0', className)} {...props} />
}
export function MessageScrollerButton() {
  const { viewport, follow, atEnd, setAtEnd } = useScroll()
  if (atEnd) return null
  return <Button variant="secondary" size="small" iconOnly leadingIcon={ArrowDownIcon} aria-label="滚动到最新" className="absolute bottom-4 left-1/2 -translate-x-1/2" onClick={() => {
    follow.current = true
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
    setAtEnd(true)
  }} />
}
