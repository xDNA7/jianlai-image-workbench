import type { VideoJob } from './api'
import type { GalleryRecord } from './types'
import { isFavoriteImage } from './store'

export type GalleryFilter = 'all' | 'images' | 'videos' | 'favorites'
export type GalleryVideo = {
  kind: 'video'
  id: string
  prompt: string
  created: number
  duration: number | null
  url: string | null
}
export type GalleryMedia =
  | { kind: 'image'; id: string; prompt: string; created: number; image: GalleryRecord }
  | GalleryVideo

export function playableVideoUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value, 'https://app.invalid')
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null
  } catch { return null }
}

export function completedVideos(records: VideoJob[]): GalleryVideo[] {
  return records.filter(video => video.status === 'done').map(video => ({
    kind: 'video', id: video.id, prompt: video.prompt || '视频作品',
    created: Number.isFinite(video.created) ? video.created! : 0,
    duration: Number.isFinite(video.duration) && video.duration! > 0 ? video.duration! : null,
    url: playableVideoUrl(video.url),
  }))
}

export function galleryMedia(images: GalleryRecord[], videos: GalleryVideo[]): GalleryMedia[] {
  return [
    ...images.map(image => ({ kind: 'image' as const, id: image.id, prompt: image.prompt, created: image.created, image })),
    ...videos,
  ].sort((a, b) => b.created - a.created || `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
}

export function filterGallery(records: GalleryMedia[], filter: GalleryFilter, favorites: string[]): GalleryMedia[] {
  if (filter === 'images') return records.filter(record => record.kind === 'image')
  if (filter === 'videos') return records.filter(record => record.kind === 'video')
  if (filter === 'favorites') return records.filter(record => record.kind === 'image' && isFavoriteImage(favorites, record.image))
  return records
}
