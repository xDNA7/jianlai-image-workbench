import { z } from 'zod'

export const templateTitleSchema = z.object({
  title: z.string().trim().min(1, '请输入模板名称').max(40, '模板名称不能超过 40 个字'),
})

export type TemplateTitleValues = z.infer<typeof templateTitleSchema>

export const videoFormSchema = z.object({
  prompt: z.string().max(2000),
  image: z.string().nullable(),
  seconds: z.number().int().min(4).max(15),
  ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
  resolution: z.enum(['768P', '2K']),
})

export type VideoFormValues = z.infer<typeof videoFormSchema>
