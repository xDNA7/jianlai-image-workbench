import { useEffect, useRef, useState } from 'react'
import { Heading, Text } from 'react-aria-components'
import { DownloadIcon, RefreshCwIcon, XIcon } from 'lucide-react'
import { Modal } from '@/boardui/modal'
import { Button, ButtonLink } from '@/boardui/button'
import { getVideo } from './api'
import { playableVideoUrl, type GalleryVideo } from './media-gallery'

type Props = { video: GalleryVideo; onClose: () => void }

/** Mounted only for the selected video. The gallery never fetches card videos. */
export function VideoLightbox({ video, onClose }: Props) {
  const player = useRef<HTMLVideoElement>(null)
  const alive = useRef(true)
  const [url, setUrl] = useState(video.url)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    const element = player.current
    return () => {
      if (!element) return
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [attempt, url, failed])
  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    setError('')
    try {
      const current = await getVideo(video.id)
      if (!alive.current) return
      const refreshed = playableVideoUrl(current.url)
      if (current.status !== 'done' || !refreshed) {
        setUrl(null)
        setError('暂时没有可播放的视频链接，请稍后重试')
        return
      }
      setUrl(refreshed)
      setFailed(false)
      setAttempt(value => value + 1)
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : '视频链接更新失败，请重试')
    } finally {
      if (alive.current) setRetrying(false)
    }
  }
  return <Modal open onOpenChange={open => !open && onClose()} label="视频作品预览"
    className="fixed inset-0 z-50 m-auto flex h-fit max-h-[94dvh] w-[min(96vw,64rem)] flex-col gap-3 overflow-y-auto rounded-2xl bg-background p-3 shadow-xl outline-none">
    <Heading slot="title" className="pr-12 text-lg font-semibold">视频作品</Heading>
    <Text slot="description" className="line-clamp-3 text-sm text-muted-foreground">{video.prompt}</Text>
    {url && !failed ? <video key={`${video.id}:${attempt}`} ref={player} src={url} controls playsInline preload="metadata" aria-label="视频作品播放器"
      onError={() => { setFailed(true); setError('视频暂时无法播放，可以更新链接后重试') }}
      className="max-h-[65dvh] w-full rounded-lg bg-black" /> : (
      <div className="grid min-h-48 place-content-center gap-2 rounded-lg bg-muted p-6 text-center text-sm text-muted-foreground">
        <p>{failed ? '视频加载失败' : '暂时没有可播放的视频链接'}</p>
        <p>作品记录已保留，可以重新获取链接。</p>
      </div>
    )}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      {url && !failed ? <ButtonLink variant="secondary" leadingIcon={DownloadIcon} href={url} download={`jianlai-video-${video.id}.mp4`} target="_blank" rel="noopener noreferrer">下载视频</ButtonLink> : null}
      <Button variant="secondary" leadingIcon={RefreshCwIcon} disabled={retrying} onClick={retry}>{retrying ? '正在更新链接…' : '更新视频链接'}</Button>
      <span className="ml-auto text-xs text-muted-foreground">{video.duration != null ? `${video.duration} 秒` : '视频'}</span>
    </div>
    <Button variant="ghost" iconOnly leadingIcon={XIcon} className="jl-dialog-close absolute top-3 right-3" aria-label="关闭视频预览" onClick={onClose} />
  </Modal>
}
