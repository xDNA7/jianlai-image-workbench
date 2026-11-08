import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, PaperclipIcon, SquareIcon, XIcon } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ai/input-group'
import { Button } from '@/boardui/button'
import { fileToDataUrl } from './api'
import { DEFAULT_EDIT_TEXT } from './marks'
import type { Upload } from './useWorkbench'

const TYPES = ['image/png', 'image/jpeg', 'image/webp']

type Props = {
  replying: boolean
  usage: { used: number; limit: number }
  /** An image was picked for editing; the next message modifies it. */
  editing: boolean
  /** Marks were placed on the picked image, so an empty message is allowed. */
  canSendEmpty?: boolean
  label?: string
  placeholder?: string
  uploadHint?: string
  uploadLabel?: string
  disabled?: boolean
  uploadReader?: (file: File) => Promise<string>
  onSend: (text: string, upload?: Upload) => void
  onStop: () => void
  onPickReference?: () => void
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Replaces the draft whenever `nonce` changes (template picked, etc.). */
  draft?: { text: string; nonce: number }
}

export function Composer({ replying, usage, editing, canSendEmpty, onSend, onStop, onPickReference, textareaRef, draft, label, placeholder, uploadHint, uploadLabel, disabled, uploadReader }: Props) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (draft) setText(draft.text)
  }, [draft?.nonce])
  const [upload, setUpload] = useState<Upload | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const pickVersion = useRef(0)
  useEffect(() => () => { pickVersion.current += 1 }, [])
  const fileRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const canSend = (text.trim().length > 0 || Boolean(canSendEmpty)) && !replying && !reading && !disabled

  const pick = async (file?: File) => {
    if (!file) return
    onPickReference?.()
    const version = ++pickVersion.current
    if (fileRef.current) fileRef.current.value = ''
    setError('')
    setUpload(null)
    setReading(true)
    try {
      const dataUrl = await (uploadReader || fileToDataUrl)(file)
      if (version === pickVersion.current) setUpload({ id: crypto.randomUUID(), name: file.name, dataUrl })
    } catch (error) {
      if (version === pickVersion.current) setError(error instanceof Error ? error.message : '图片读取失败，请重试')
    } finally {
      if (version === pickVersion.current) setReading(false)
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSend) return
    onSend(text.trim() || DEFAULT_EDIT_TEXT, upload ?? undefined)
    setText('')
    setUpload(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <form ref={formRef} onSubmit={submit} className="grid gap-1.5">
      <InputGroup className="h-auto flex-col items-stretch rounded-2xl bg-card shadow-sm">
        {upload ? (
          <InputGroupAddon align="block-start">
            <div className="relative shrink-0">
              <img src={upload.dataUrl} alt={upload.name} className="size-14 rounded-lg object-cover" />
              <Button
                size="xs"
                variant="secondary"
                iconOnly
                leadingIcon={XIcon}
                aria-label="移除参考图"
                className="absolute -top-2 -right-2 rounded-full"
                onClick={() => {
                  pickVersion.current += 1
                  setUpload(null)
                  if (fileRef.current) fileRef.current.value = ''
                }}
              />
            </div>
            <div className="min-w-0 text-sm leading-5">
              <p className="break-all">{upload.name}</p>
              <p className="text-muted-foreground">{uploadHint || '按本次照片与新指令创作，不沿用之前的描述。'}</p>
            </div>
          </InputGroupAddon>
        ) : null}
        <InputGroupTextarea
          ref={textareaRef}
          value={text}
          maxLength={2000}
          rows={2}
          aria-label={label || '描述你想要的画面'}
          placeholder={placeholder || (editing ? '说说想怎么修改这张图…' : '描述你想要的画面…')}
          className="max-h-48 min-h-14 p-3 text-base"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              formRef.current?.requestSubmit()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <input
            ref={fileRef}
            type="file"
            accept={TYPES.join(',')}
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <Button
            size="small"
            variant="secondary"
            iconOnly
            leadingIcon={PaperclipIcon}
            className="rounded-full"
            aria-label={uploadLabel || '上传参考图'}
            onClick={() => fileRef.current?.click()}
          />
          <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
            {reading ? '正在读取参考图…' : `今日对话 ${usage.used}/${usage.limit}`}
          </span>
          {replying ? (
            <Button size="small" variant="primary" iconOnly leadingIcon={SquareIcon} className="rounded-full" aria-label="停止回复" onClick={onStop} />
          ) : (
            <Button type="submit" size="small" variant="primary" iconOnly leadingIcon={ArrowUpIcon} className="rounded-full" aria-label="发送" disabled={!canSend} />
          )}
        </InputGroupAddon>
      </InputGroup>
      {error ? <p role="alert" className="px-2 text-xs text-destructive">{error}</p> : null}
    </form>
  )
}
