import { describe, expect, test } from 'bun:test'
import { completedVideos, filterGallery, galleryMedia, playableVideoUrl } from '../src/chat/media-gallery'
import type { GalleryRecord } from '../src/chat/types'
import type { VideoJob } from '../src/chat/api'

const image = (id: string, created: number): GalleryRecord => ({ id, jobId: id, index: 0, preview: '/image.png', download: '/original.png', prompt: id, created })
const video = (id: string, created: number, extra: Partial<VideoJob> = {}): VideoJob => ({ id, status: 'done', prompt: id, created, duration: 10, url: 'https://media.example/video.mp4', ...extra })

describe('unified media gallery', () => {
  test('merges only completed videos with images in newest-first order without losing unavailable old works', () => {
    const videos = completedVideos([
      video('new video', 30), video('queued', 40, { status: 'queued' }),
      video('old video', 5, { url: null }), video('failed', 50, { status: 'failed' }),
    ])
    const media = galleryMedia([image('image', 20)], videos)
    expect(media.map(value => [value.kind, value.id])).toEqual([['video', 'new video'], ['image', 'image'], ['video', 'old video']])
    expect(videos.find(value => value.id === 'old video')?.url).toBeNull()
  })

  test('media filters keep image favorite semantics and video never masquerades as an image index', () => {
    const media = galleryMedia([image('starred', 10), image('other', 9)], completedVideos([video('video', 20)]))
    expect(filterGallery(media, 'videos', []).map(value => value.id)).toEqual(['video'])
    expect(filterGallery(media, 'images', []).map(value => value.id)).toEqual(['starred', 'other'])
    expect(filterGallery(media, 'favorites', ['starred']).map(value => value.id)).toEqual(['starred'])
    expect(filterGallery(media, 'all', [])).toHaveLength(3)
  })

  test('untrusted media protocols or credentials never become playable links', () => {
    expect(playableVideoUrl('javascript:alert(1)')).toBeNull()
    expect(playableVideoUrl('data:video/mp4;base64,AAAA')).toBeNull()
    expect(playableVideoUrl('https://user:password@example.test/private.mp4')).toBeNull()
    expect(playableVideoUrl('https://media.example/video.mp4?signature=example')).toBe('https://media.example/video.mp4?signature=example')
    expect(playableVideoUrl('/jianlai/api/videos/video')).toBe('/jianlai/api/videos/video')
  })
})
