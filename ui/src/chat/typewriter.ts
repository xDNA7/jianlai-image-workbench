import { useEffect, useRef, useState } from 'react'

/**
 * The Terra gateway returns a reply in one burst, so the UI reveals it
 * character by character. A block finishes in about 2.2 s, never slower
 * than 40 characters per second.
 */
export function advance(shown: number, total: number, dtMs: number): number {
  if (shown >= total) return total
  const rate = Math.max(40, total / 2.2)
  return Math.min(total, shown + (rate * dtMs) / 1000)
}

/** Cuts at `count` UTF-16 units without leaving half of a surrogate pair. */
export function sliceChars(text: string, count: number): string {
  const n = Math.floor(count)
  if (n >= text.length) return text
  const out = text.slice(0, Math.max(0, n))
  const last = out.charCodeAt(out.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out
}

// Ids already revealed in this page session, so returning to the chat view
// (or remounting) never replays the animation.
const revealed = new Set<string>()

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function useTypewriter(id: string, text: string, enabled: boolean) {
  const active = enabled && !revealed.has(id) && !prefersReducedMotion()
  const latest = useRef(text)
  latest.current = text
  const shown = useRef(active ? 0 : text.length)
  const [, rerender] = useState(0)

  useEffect(() => {
    if (!active) {
      shown.current = latest.current.length
      rerender((n) => n + 1)
      return
    }
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const total = latest.current.length
      const next = advance(shown.current, total, now - last)
      last = now
      if (next !== shown.current) {
        shown.current = next
        rerender((n) => n + 1)
      }
      if (next < total) raf = requestAnimationFrame(step)
      else if (total > 0) revealed.add(id)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [active, id, text.length])

  const count = active ? shown.current : text.length
  return { visible: sliceChars(text, count), done: count >= text.length }
}
