import { useState } from 'react'
import { Heading, Text } from 'react-aria-components'
import { Modal } from '@/boardui/modal'
import { useForm } from 'react-hook-form'
import { BookmarkPlusIcon, DownloadIcon, PencilIcon, StarIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button, ButtonLink } from '@/boardui/button'
import { Input } from '@/components/ai/input'
import { ZoomViewer } from './ZoomViewer'
import { templateTitleSchema, type TemplateTitleValues } from './schemas'

export type LightboxImage = {
  id: string
  jobId: string
  index: number
  preview: string
  download: string
  prompt: string
  text?: string
}

type Props = {
  image: LightboxImage | null
  favorite: boolean
  onClose: () => void
  onFavorite: (image: LightboxImage) => void
  onSaveTemplate: (title: string, image: LightboxImage) => void
  onContinue: (image: LightboxImage) => void
  onDelete: (image: LightboxImage) => Promise<void>
}

export function Lightbox({ image, favorite, onClose, onFavorite, onSaveTemplate, onContinue, onDelete }: Props) {
  const [naming, setNaming] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleForm = useForm<TemplateTitleValues>({ defaultValues: { title: '' } })
  const close = () => {
    setConfirming(false)
    setNaming(false)
    titleForm.reset()
    setSaved(false)
    setError('')
    onClose()
  }
  const remove = async () => {
    if (!image) return
    setBusy(true)
    setError('')
    try {
      await onDelete(image)
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={image != null} onOpenChange={(open) => !open && close()} className="fixed inset-0 z-50 m-auto flex h-fit max-h-[94dvh] w-[min(96vw,64rem)] flex-col gap-3 overflow-y-auto rounded-2xl bg-background p-3 shadow-xl outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <Heading slot="title" className="sr-only">作品预览</Heading>
          <Text slot="description" className="sr-only">{image?.prompt}</Text>
          {image ? (
            <>
              <ZoomViewer key={image.id} preview={image.preview} original={image.download} alt={image.prompt} />
              <p className="line-clamp-3 text-sm text-muted-foreground">{image.prompt}</p>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              {saved ? <p role="status" className="text-sm text-primary">已保存到我的模板</p> : null}
              {naming ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={titleForm.handleSubmit((values) => {
                    const parsed = templateTitleSchema.safeParse(values)
                    if (!parsed.success) {
                      titleForm.setError('title', { message: parsed.error.issues[0]?.message || '请输入模板名称' })
                      return
                    }
                    onSaveTemplate(parsed.data.title, image)
                    setNaming(false)
                    setSaved(true)
                  })}
                >
                  <Input
                    maxLength={40}
                    aria-label="模板名称"
                    aria-invalid={Boolean(titleForm.formState.errors.title)}
                    {...titleForm.register('title')}
                    className="max-w-xs"
                  />
                  <Button type="submit" disabled={!titleForm.watch('title')?.trim()}>保存</Button>
                  <Button type="button" variant="ghost" onClick={() => { setNaming(false); titleForm.reset() }}>取消</Button>
                  {titleForm.formState.errors.title ? <p role="alert" className="basis-full text-xs text-destructive">{titleForm.formState.errors.title.message}</p> : null}
                </form>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => onContinue(image)} leadingIcon={PencilIcon}>修改这张图</Button>
                <ButtonLink variant="secondary" leadingIcon={DownloadIcon} href={image.download} download={`jianlai-${image.id}.png`} target="_blank" rel="noreferrer">下载原图</ButtonLink>
                <Button variant="secondary" aria-pressed={favorite} onClick={() => onFavorite(image)} leadingIcon={StarIcon} className={favorite ? '[&_svg]:fill-amber-400 [&_svg]:text-amber-400' : ''}>{favorite ? '已收藏' : '收藏'}</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    titleForm.reset({ title: (image.prompt || '我的创作').slice(0, 20) })
                    setNaming(true)
                    setSaved(false)
                  }}
                >
                  <BookmarkPlusIcon aria-hidden="true" />存为模板
                </Button>
                <div className="ml-auto">
                  {confirming ? (
                    <span className="flex items-center gap-2 text-sm">
                      从画廊移除？
                      <Button variant="danger" size="small" disabled={busy} onClick={remove}>确认移除</Button>
                      <Button variant="ghost" size="small" onClick={() => setConfirming(false)}>取消</Button>
                    </span>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirming(true)} leadingIcon={Trash2Icon}>移除</Button>
                  )}
                </div>
              </div>
            </>
          ) : null}
          <Button variant="ghost" iconOnly leadingIcon={XIcon} className="jl-dialog-close absolute top-4 right-4" aria-label="关闭" onClick={close} />
        </Modal>
  )
}
