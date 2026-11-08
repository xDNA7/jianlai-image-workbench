export const videoAccessExpiredEvent = 'jianlai:video-access-expired'

export function notifyVideoAccessExpired() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(videoAccessExpiredEvent))
}
