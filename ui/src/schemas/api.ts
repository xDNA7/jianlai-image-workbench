import { z } from 'zod'

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
    preview: z.string(), download: z.string(), prompt: z.string(), text: z.string().optional(),
  })),
})

export type BootstrapContract = z.infer<typeof bootstrapSchema>

export function parseApiError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
