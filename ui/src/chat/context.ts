import { jobImageReferenceUrl } from './api'
import { normalizeAnimation, recommendAnimation } from './animation'
import type { Reference, ThreadItem } from './types'

/** Explicit changes stay edits even when they mention a new colour or style. */
export function withoutReference(text: string): boolean {
  return /(?:不|别|不要|无需)(?:再)?(?:用|使用|带|参考|沿用)(?:任何)?(?:参考图|原图|上[一张幅次]+(?:图|图片)?|旧图|前文|上下文)|不参考|不要参考/.test(text)
}

export function imageIntent(text: string): 'new' | 'edit' | 'continue' {
  if (/(?:不要|不用|不必)(?:再)?(?:生成|画)?新图/.test(text)) return 'edit'
  if (withoutReference(text) || /(?:另|重新)(?:画|生成|创作)(?:一张|一幅)?(?:全)?新图|(?:生成|画|创作)(?:一张|一幅)?(?:全)?新图|全新(?:图片|画面|主题)|(?:完全)?独立(?:的|创作|生成)|新(?:画一张|的主题)/.test(text)) return 'new'
  const firstClause = text.split(/[，,。；;\n]/)[0]
  if (/^(?:请|帮我|请帮我)?(?:再|另外|重新)?(?:画|生成|创作|制作)(?:一|两|2|幅|张|个)/.test(firstClause) && !/上一张|这张|原图|参考|刚才|重新生成/.test(firstClause)) return 'new'
  if (/(?:修改|改成|改为|改一下|调整|保持|保留|换成|换个|换一个|换背景|换颜色|去掉|删掉|添加|增加|再亮|再暗|没动|动起来|继续|上一张|这张|刚才|刚刚|重新生成)/.test(text)) return 'edit'
  if (/另画/.test(text)) return 'new'
  return 'continue'
}

export function briefStart(items: ThreadItem[]): number {
  let start = 0
  items.forEach((item, index) => {
    if (item.type === 'user' && (item.contextStart || item.reference?.kind === 'upload' || imageIntent(item.text) === 'new')) start = index
  })
  return start
}

export function previousReference(items: ThreadItem[]): Reference | undefined {
  const current = items.slice(briefStart(items))
  for (let index = current.length - 1; index >= 0; index--) {
    const item = current[index]
    if (item.type === 'job' && item.images.length && item.status === 'done') {
      const image = item.images[0]
      return {
        kind: 'previous', url: jobImageReferenceUrl(image.jobId, image.index), preview: image.preview, prompt: image.prompt,
        animation: image.type === 'image/gif' ? image.animation
          ? normalizeAnimation({ fps: image.animation.fps, durationSeconds: image.animation.durationMs / 1000 }, 'GIF')
          : recommendAnimation('GIF') : undefined,
      }
    }
    if (item.type === 'assistant' && item.reference) return item.reference
  }
}
