/** Persist only an opaque idempotency key and digest, never user media or text. */
export type PendingVideo = { key: string; hash: string }
export type VideoPayload = {
  prompt: string
  duration: number
  ratio: string
  resolution: string
  image: string
}

const storageKey = (accountId: string) => `jianlai:pending-video:${encodeURIComponent(accountId)}`

export function readPendingVideo(accountId: string): PendingVideo | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(accountId)) || 'null')
    if (value && typeof value === 'object' && 'key' in value && 'hash' in value &&
      typeof value.key === 'string' && /^[0-9a-f-]{36}$/.test(value.key) &&
      typeof value.hash === 'string' && /^[0-9a-f]{64}$/.test(value.hash)) {
      return { key: value.key, hash: value.hash }
    }
  } catch { /* Unavailable or invalid storage is handled before any new POST. */ }
  return null
}

export function writePendingVideo(accountId: string, pending: PendingVideo): void {
  sessionStorage.setItem(storageKey(accountId), JSON.stringify(pending))
}

export function clearPendingVideo(accountId: string): void {
  sessionStorage.removeItem(storageKey(accountId))
}

export async function videoPayloadHash(payload: VideoPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    prompt: payload.prompt, duration: payload.duration, ratio: payload.ratio,
    resolution: payload.resolution, image: payload.image,
  }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
