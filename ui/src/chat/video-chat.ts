import { ApiError, apiBase, createSseParser } from './api'
import { notifyVideoAccessExpired } from './video-access-events'
import { normalizeStoryboard, type VideoStoryboard } from './video-storyboard'

export type VideoMessage = { role: 'user' | 'assistant'; content: string }
export type VideoChatHandlers = {
  onDelta: (text: string) => void
  onStoryboard: (storyboard: VideoStoryboard) => void
  onMeta: (used: number, limit: number) => void
}

export async function streamVideoChat(messages: VideoMessage[], video: { duration: number; ratio?: VideoStoryboard['ratio']; resolution?: VideoStoryboard['resolution'] }, handlers: VideoChatHandlers, signal: AbortSignal) {
  const response = await fetch(`${apiBase()}api/chat`, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ mode: 'video', messages, video }),
  })
  if (!response.ok || !response.body) {
    if (response.status === 401) notifyVideoAccessExpired()
    const body: unknown = await response.json().catch(() => null)
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '视频分镜暂时无法整理，请重试'
    throw new ApiError(response.status, message)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parse = createSseParser()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      for (const event of parse(done ? decoder.decode() : decoder.decode(value, { stream: true }))) {
        const data: unknown = JSON.parse(event.data || '{}')
        if (!data || typeof data !== 'object') throw new Error('视频分镜响应格式无效，请重试')
        if (event.event === 'delta' && 'text' in data && typeof data.text === 'string') handlers.onDelta(data.text)
        else if (event.event === 'meta' && 'used' in data && 'limit' in data && typeof data.used === 'number' && typeof data.limit === 'number') handlers.onMeta(data.used, data.limit)
        else if (event.event === 'storyboard') {
          const plan = normalizeStoryboard(data)
          if (!plan) throw new Error('分镜内容或时长无效，请让助手重新整理')
          handlers.onStoryboard(plan)
        } else if (event.event === 'error') throw new Error('error' in data && typeof data.error === 'string' ? data.error : '视频分镜整理失败，请重试')
        else if (event.event === 'done') return
      }
      if (done) throw new Error('分镜对话中断，请重试；尚未提交视频任务')
    }
  } finally { await reader.cancel().catch(() => undefined) }
}
