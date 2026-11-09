import type { Mark } from './marks'

export type AnimationPlan = { fps: number; durationSeconds: number; frames: number; notice?: string }
export type AnimationMetadata = { frames: number; durationMs: number; fps: number; width: number; height: number }

export type Plan = {
  animation?: AnimationPlan
  prompt: string
  text: string
  size: string
  quality: string
  count: 1 | 2
  useReference: boolean
  publicFigureVisual?: boolean
  publicFigures?: string[]
  publicFigureContext?: string
  publicFigure?: string
  publicFigureSource?: PublicFigureSource
  publicFigureSources?: PublicFigureSource[]
}

export type PublicFigureSource = { provider?: string; title: string; thumbUrl: string; imageUrl: string; sourceUrl: string; artist: string; license: string; licenseUrl?: string; entityId?: string; personName?: string }

export type Reference =
  | { kind: 'picked' | 'previous'; url: string; preview: string; prompt: string; marks?: Mark[]; source?: PublicFigureSource; animation?: AnimationPlan }
  | { kind: 'upload'; id: string; name: string; preview: string }

export type JobImage = {
  type?: string
  animation?: AnimationMetadata
  id: string
  jobId: string
  index: number
  preview: string
  download: string
  prompt: string
  /** Poster text of the plan that produced the image, used when saving a template. */
  text?: string
}

export type UserItem = {
  type: 'user'
  id: string
  text: string
  reference?: Reference
  contextStart?: boolean
  created: number
}

export type AssistantItem = {
  type: 'assistant'
  id: string
  text: string
  status: 'streaming' | 'done' | 'error'
  error?: string
  plan?: Plan
  planState?: 'open' | 'submitted' | 'dismissed'
  /** Original user text, used for "generate as written" fallback. */
  source: string
  reference?: Reference
  created: number
}

export type JobItem = {
  type: 'job'
  id: string
  jobId?: string
  requestKey: string
  plan: Plan
  reference?: Reference
  status: 'submitting' | 'running' | 'unknown' | 'done' | 'failed'
  phase?: string
  error?: string
  images: JobImage[]
  chargedCents?: number
  started: number
  created: number
}

export type NoteItem = {
  type: 'note'
  id: string
  text: string
  created: number
}

export type ThreadItem = UserItem | AssistantItem | JobItem | NoteItem

export type Option = { value: string; label: string }

export type Capabilities = {
  sizes: Option[]
  qualities: Option[]
  priceCents: number
}

export type GalleryRecord = {
  type?: string
  animation?: AnimationMetadata
  id: string
  jobId: string
  index: number
  preview: string
  download: string
  prompt: string
  created: number
  text?: string
}

export type Template = {
  id: string
  title: string
  prompt: string
  text: string
  size?: string
  preview: string
  category?: string
  /** User-saved template kept in this browser (category "mine"). */
  private?: boolean
  /** Original-size image of a saved template. */
  image?: string
}
