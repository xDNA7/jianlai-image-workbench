import { z } from 'zod'
import type { components } from '../api/generated'

type Wire = components['schemas']

const animationMetadata = z.object({ frames: z.number().int().positive(), durationMs: z.number().nonnegative(), fps: z.number().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() })

const option = z.object({ value: z.string(), label: z.string() })

export const capabilitiesSchema = z.object({
  sizes: z.array(option).default([]),
  qualities: z.array(option).default([]),
  priceCents: z.number().int().nonnegative().default(30),
})

export const bootstrapSchema = z.object({
  accountId: z.string().min(1),
  availableCents: z.number().int().nonnegative().nullable(),
  capabilities: capabilitiesSchema,
  activeJobId: z.string().optional(),
  activeRequestKey: z.string().optional(),
})

export const jobStateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['running', 'done', 'failed']),
  phase: z.string().optional(),
  error: z.string().optional(),
  chargedCents: z.number().int().nonnegative(),
  availableCents: z.number().int().nonnegative().nullable(),
  images: z.array(z.object({
    id: z.string(), jobId: z.string(), index: z.number().int().nonnegative(),
    type: z.string().optional(), animation: animationMetadata.optional(),
    preview: z.string(), download: z.string(), prompt: z.string(), text: z.string().optional(),
  })),
})

export type BootstrapContract = z.infer<typeof bootstrapSchema>

export function parseApiError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

// Wire models validate server data before it becomes normalized UI state.
const rawImageSchema = z.object({
  index: z.number().int().nonnegative(), url: z.string(),
  type: z.string().optional(), animation: animationMetadata.nullish(),
  previewUrl: z.string().nullish(), downloadUrl: z.string().optional(),
})

export const imageJobResponseSchema = z.object({
  id: z.string().min(1), status: z.enum(['running', 'done', 'failed']),
  requestKey: z.string().optional(), phase: z.string().optional(), error: z.string().optional(),
  charged: z.number().nonnegative().default(0),
  availableCents: z.number().int().nonnegative().nullable().default(null),
  images: z.array(rawImageSchema).default([]),
}) satisfies z.ZodType<Wire['ImageJob']>

export const videoJobResponseSchema = z.object({
  id: z.string().min(1), status: z.enum(['queued', 'running', 'done', 'failed']),
  phase: z.string().optional(), error: z.string().optional(),
  availableCents: z.number().int().nonnegative().nullish(),
  chargedCents: z.number().int().nonnegative().optional(),
  url: z.string().nullable().optional(), duration: z.number().int().optional(),
  ratio: z.string().optional(), prompt: z.string().optional(),
  progress: z.number().optional(), estimatedSeconds: z.number().optional(), elapsedSeconds: z.number().optional(),
}).passthrough() satisfies z.ZodType<Wire['VideoJob']>

export const bootstrapResponseSchema = z.object({
  accountId: z.string().min(1), availableCents: z.number().int().nonnegative().nullable(),
  imagePriceCents: z.number().int().nonnegative().optional(),
  capabilities: z.object({
    sizes: z.array(option).default([]), qualities: z.array(option).default([]),
    unitPrice: z.number().int().nonnegative().optional(),
  }),
  activeJob: z.object({
    id: z.string(), status: z.enum(['running', 'done', 'failed']), requestKey: z.string().optional(),
  }).nullish(),
  activeVideo: videoJobResponseSchema.nullish(),
}) satisfies z.ZodType<Wire['Bootstrap']>

export const historyResponseSchema = z.object({
  records: z.array(z.object({
    id: z.string(), jobId: z.string(), index: z.number().int().nonnegative(),
    type: z.string().optional(), animation: animationMetadata.nullish(),
    image: z.string(), previewUrl: z.string().nullish(), downloadUrl: z.string().optional(),
    prompt: z.string().optional(), text: z.string().optional(), created: z.number(),
  })),
}) satisfies z.ZodType<Wire['History']>

const templateResponseSchema = z.object({
  id: z.string(), title: z.string(), prompt: z.string().optional(), description: z.string().optional(),
  text: z.string().optional(), size: z.string().optional(), preview: z.string().optional(),
  category: z.string().optional(), parameterDefaults: z.record(z.string(), z.string()).optional(),
})
export const templatesResponseSchema = z.object({ templates: z.array(templateResponseSchema) }) satisfies z.ZodType<Wire['Templates']>
export const videosResponseSchema = z.object({ records: z.array(videoJobResponseSchema) }) satisfies z.ZodType<Wire['Videos']>
export const chatUsageResponseSchema = z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }) satisfies z.ZodType<Wire['ChatUsage']>
