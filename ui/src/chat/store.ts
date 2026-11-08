import type { JobItem, Reference, Template, ThreadItem } from './types'

export const THREAD_LIMIT = 200
const PREFIX = 'jianlai-chat:v1:'
const FAVORITES = 'jianlai-favorites'
const PRIVATE_TEMPLATES = 'jianlai-private-templates'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function threadKey(accountId: string) {
  return `${PREFIX}${accountId}`
}

/** Keeps the newest items, never splitting a user turn from its reply. */
export function trimThread(items: ThreadItem[], limit = THREAD_LIMIT): ThreadItem[] {
  if (items.length <= limit) return items
  let start = items.length - limit
  while (start < items.length && items[start].type !== 'user') start += 1
  return start >= items.length ? items.slice(-limit) : items.slice(start)
}

function stripReference(ref?: Reference): Reference | undefined {
  // Private uploaded pixels stay in memory; plans can bind the file again.
  if (!ref) return undefined
  return ref.kind === 'upload' ? { ...ref, preview: '' } : ref
}

/** Refresh preserves request identity until the server outcome is known. */
export function sanitize(items: ThreadItem[]): ThreadItem[] {
  return items.map((item): ThreadItem => {
    if (item.type === 'assistant') {
      const reference = stripReference(item.reference)
      if (item.status === 'streaming') {
        return { ...item, reference, status: 'error', error: '页面刷新，回复已中断' }
      }
      return { ...item, reference }
    }
    if (item.type === 'user') return { ...item, reference: stripReference(item.reference) }
    if (item.type === 'job') {
      const reference = stripReference(item.reference)
      if (item.jobId && (item.status === 'unknown' || item.status === 'submitting' || (item.status === 'failed' && item.phase !== 'failed'))) {
        return { ...item, reference, status: 'running', error: undefined }
      }
      if (item.status === 'submitting' || (item.status === 'failed' && item.phase !== 'failed')) {
        return { ...item, reference, status: 'unknown', error: '提交被中断，尚未确认服务端是否接单；请先到画廊核对任务和费用' }
      }
      return { ...item, reference }
    }
    return item
  })
}

export function loadThread(accountId: string, storage: StorageLike): ThreadItem[] {
  try {
    const raw = storage.getItem(threadKey(accountId))
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    const valid = data.filter(
      (i) => i && typeof i === 'object' && ['user', 'assistant', 'job', 'note'].includes(i.type) && typeof i.id === 'string',
    )
    return sanitize(trimThread(valid as ThreadItem[]))
  } catch {
    return []
  }
}

export function saveThread(accountId: string, items: ThreadItem[], storage: StorageLike) {
  try {
    storage.setItem(threadKey(accountId), JSON.stringify(sanitize(trimThread(items))))
  } catch {
    // Quota or private mode: the thread simply is not persisted.
  }
}

export function clearThread(accountId: string, storage: StorageLike) {
  try {
    storage.removeItem(threadKey(accountId))
  } catch {
    // ignore
  }
}

export function loadFavorites(storage: StorageLike): string[] {
  try {
    const data = JSON.parse(storage.getItem(FAVORITES) || '[]')
    return Array.isArray(data) ? data.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function saveFavorites(ids: string[], storage: StorageLike) {
  try {
    storage.setItem(FAVORITES, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** New uploads start a separate image brief while keeping visible history intact. */
export function toChatMessages(items: ThreadItem[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let start = 0
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.type === 'user' && item.reference?.kind === 'upload') start = index
  }
  for (const item of items.slice(start)) {
    if (item.type === 'user' && item.text.trim()) out.push({ role: 'user', content: item.text })
    else if (item.type === 'assistant' && item.status === 'done' && item.text.trim()) {
      out.push({ role: 'assistant', content: item.text })
    }
  }
  return out
}

export function jobSummary(job: JobItem) {
  const { plan } = job
  const price = `${plan.count} 张`
  return `${price} · ${plan.quality} · ${plan.size}`
}

export type FavoriteTarget = { id: string; preview?: string; download?: string }

/**
 * The previous UI stored favourites by image URL, this one by `jobId-index`.
 * Match on any of them so old stars keep showing.
 */
export function favoriteKeys(target: FavoriteTarget): string[] {
  return [target.id, target.preview, target.download].filter((v): v is string => Boolean(v))
}

export function isFavoriteImage(favorites: string[], target: FavoriteTarget): boolean {
  const keys = favoriteKeys(target)
  return favorites.some((f) => keys.includes(f))
}

/** Removes every matching key when already starred, otherwise adds the id. */
export function toggleFavoriteKeys(favorites: string[], target: FavoriteTarget): string[] {
  return isFavoriteImage(favorites, target)
    ? favorites.filter((f) => !favoriteKeys(target).includes(f))
    : [...favorites, target.id]
}

export function loadPrivateTemplates(storage: StorageLike): Template[] {
  try {
    const data = JSON.parse(storage.getItem(PRIVATE_TEMPLATES) || '[]')
    if (!Array.isArray(data)) return []
    return data
      .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && typeof t.title === 'string')
      .map((t) => ({
        ...t,
        prompt: String(t.prompt || ''),
        text: String(t.text || ''),
        preview: String(t.preview || ''),
        private: true,
        category: 'mine',
      }))
  } catch {
    return []
  }
}

export function savePrivateTemplates(list: Template[], storage: StorageLike) {
  try {
    storage.setItem(PRIVATE_TEMPLATES, JSON.stringify(list))
  } catch {
    // ignore: quota or private mode
  }
}

/** Same shape the previous UI wrote, so both UIs can read the list. */
export function makePrivateTemplate(
  title: string,
  image: { prompt: string; text?: string; preview: string; download: string },
  now = Date.now(),
): Template {
  return {
    id: `private-${now}`,
    title: title.trim(),
    prompt: image.prompt,
    text: image.text || '',
    image: image.download,
    preview: image.preview,
    private: true,
    category: 'mine',
  }
}
