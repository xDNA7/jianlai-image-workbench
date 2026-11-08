import { z } from 'zod'

export const adminLoginSchema = z.object({
  username: z.string().trim().min(1, '请输入管理员账号'),
  password: z.string().min(1, '请输入密码'),
})

export const adminRechargeSchema = z.object({
  amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/, '请输入大于 0 且最多两位小数的金额')
    .refine(value => Number.isFinite(Number(value)) && Number(value) > 0, '请输入大于 0 且最多两位小数的金额'),
})

export const adminSessionSchema = z.object({
  authenticated: z.boolean().default(false),
  username: z.string().optional(),
  csrf: z.string().optional(),
  balance: z.number().optional(),
  available: z.number().optional(),
  reserved: z.number().optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
})

export const adminTemplateSchema = z.object({
  id: z.string(), title: z.string().default(''), category: z.string().optional(),
  tags: z.array(z.string()).default([]), prompt: z.string().default(''),
  text: z.string().default(''), preview: z.string().optional(),
})

export const adminUserSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String), imageCount: z.number().optional(), lastCreated: z.number().nullish(),
})

export const adminListSchema = <T extends z.ZodTypeAny>(item: T) => z.object({
  templates: z.array(item).optional(), users: z.array(item).optional(),
})


export const adminImageSchema = z.object({
  id: z.string(), jobId: z.string(), index: z.number().int().nonnegative(),
  url: z.string().nullish(), previewUrl: z.string().nullish(), downloadUrl: z.string().nullish(),
  created: z.number(), expiresAt: z.number().nullish(), hiddenUser: z.boolean().optional(),
  prompt: z.string().optional(), text: z.string().optional(),
})
