import { useEffect, useRef, useState } from 'react'
import { Heading, Text } from 'react-aria-components'
import { Modal } from '@/boardui/modal'
import { MousePointer2Icon, ScanIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import { Textarea } from '@/components/ai/textarea'
import { MAX_MARKS, NOTE_MAX, boxBetween, incompleteCount, newMark, pointIn } from './marks'
import type { Mark } from './marks'

export type AnnotateTarget = { url: string; preview: string; prompt: string; marks: Mark[] }

type Props = {
  target: AnnotateTarget | null
  onCancel: () => void
  onConfirm: (target: AnnotateTarget, marks: Mark[]) => void
}

type Draft = { x: number; y: number; ex: number; ey: number }

function Body({ target, onCancel, onConfirm }: { target: AnnotateTarget } & Omit<Props, 'target'>) {
  const [marks, setMarks] = useState<Mark[]>(target.marks)
  const [tool, setTool] = useState<'point' | 'area'>('point')
  const [draft, setDraft] = useState<Draft | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const notes = useRef(new Map<string, HTMLTextAreaElement>())
  const focusLast = useRef(false)
  const missing = incompleteCount(marks)

  // Focus the new note after the pointer's own events are done: the browser
  // moves focus on mousedown/click, which would otherwise take it back.
  useEffect(() => {
    if (!focusLast.current) return
    focusLast.current = false
    const last = marks[marks.length - 1]
    if (!last) return
    // No cleanup on purpose: a later render must not cancel the pending focus.
    // The ref map drops the textarea on unmount, so a late call is a no-op.
    setTimeout(() => notes.current.get(last.id)?.focus(), 0)
  }, [marks])

  const add = (mark: Mark) => {
    focusLast.current = true
    setMarks((list) => (list.length >= MAX_MARKS ? list : [...list, mark]))
  }
  const at = (e: React.PointerEvent) => pointIn(frame.current!.getBoundingClientRect(), e.clientX, e.clientY)
  const patch = (id: string, note: string) => setMarks((list) => list.map((m) => (m.id === id ? { ...m, note } : m)))

  const finish = (e: React.PointerEvent) => {
    if (!draft) return
    const end = at(e)
    setDraft(null)
    const box = boxBetween(draft, end)
    if (box) add(newMark({ type: 'area', ...box }))
  }

  return (
    <>
      <Heading slot="title" className="text-base font-semibold">点选要修改的位置</Heading>
      <Text slot="description" className="text-sm text-muted-foreground">
        点一下标出位置，或拖动框出区域，再写这里要怎么改。
      </Text>
      <div
        role="group"
        aria-label="标记方式"
        className="jl-mark-tool flex w-fit gap-1 rounded-2lg bg-muted p-1"
      >
        <Button variant={tool === 'point' ? 'secondary' : 'ghost'} size="small" leadingIcon={MousePointer2Icon} aria-pressed={tool === 'point'} onClick={() => setTool('point')}>点选</Button>
        <Button variant={tool === 'area' ? 'secondary' : 'ghost'} size="small" leadingIcon={ScanIcon} aria-pressed={tool === 'area'} onClick={() => setTool('area')}>框选</Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain md:flex-row">
        <div className="flex shrink-0 justify-center rounded-xl bg-muted p-2 md:flex-1">
          <div
            ref={frame}
            data-testid="annotate-frame"
            className="relative inline-block touch-none select-none"
            style={{ cursor: tool === 'point' ? 'crosshair' : 'cell' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              const p = at(e)
              if (tool === 'point') return add(newMark({ type: 'point', ...p }))
              e.currentTarget.setPointerCapture(e.pointerId)
              setDraft({ ...p, ex: p.x, ey: p.y })
            }}
            onPointerMove={(e) => draft && setDraft({ ...draft, ...(({ x, y }) => ({ ex: x, ey: y }))(at(e)) })}
            onPointerUp={finish}
            onPointerCancel={() => setDraft(null)}
          >
            <img
              src={target.preview}
              alt="待修改的图片"
              draggable={false}
              className="block max-h-[42dvh] w-auto max-w-full object-contain md:max-h-[60dvh]"
            />
            {marks.map((m, i) =>
              m.type === 'point' ? (
                <span
                  key={m.id}
                  className="absolute z-10 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-primary text-xs font-semibold text-white shadow"
                  style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
                >
                  {i + 1}
                </span>
              ) : (
                <span
                  key={m.id}
                  className="absolute z-10 border-2 border-primary bg-primary/15"
                  style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
                >
                  <span className="absolute -top-3 -left-3 grid size-6 place-items-center rounded-full border-2 border-white bg-primary text-xs font-semibold text-white">
                    {i + 1}
                  </span>
                </span>
              ),
            )}
            {draft ? (
              <span
                className="absolute z-10 border-2 border-dashed border-primary bg-primary/10"
                style={{
                  left: `${Math.min(draft.x, draft.ex) * 100}%`,
                  top: `${Math.min(draft.y, draft.ey) * 100}%`,
                  width: `${Math.abs(draft.ex - draft.x) * 100}%`,
                  height: `${Math.abs(draft.ey - draft.y) * 100}%`,
                }}
              />
            ) : null}
          </div>
        </div>
        <div className="grid content-start gap-2 md:w-72 md:shrink-0 md:overflow-y-auto">
          {marks.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              还没有标记。不标记直接确定，也可以只用文字描述修改。
            </p>
          ) : null}
          {marks.map((m, i) => (
            <div key={m.id} className="flex items-start gap-2 rounded-xl border border-border p-2">
              <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-white">
                {i + 1}
              </span>
              <Textarea
                ref={(node) => {
                  if (node) notes.current.set(m.id, node)
                  else notes.current.delete(m.id)
                }}
                value={m.note}
                rows={2}
                maxLength={NOTE_MAX}
                aria-label={`标记 ${i + 1} 的修改要求`}
                placeholder="这里要怎么改"
                className="min-h-14 flex-1 text-sm"
                onChange={(e) => patch(m.id, e.target.value)}
              />
              <Button
                variant="ghost"
                size="small"
                iconOnly
                leadingIcon={Trash2Icon}
                aria-label={`删除标记 ${i + 1}`}
                onClick={() => setMarks((list) => list.filter((x) => x.id !== m.id))}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{marks.length}/{MAX_MARKS} 个标记</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {missing > 0 ? (
          <span role="status" className="mr-auto text-xs text-destructive">还有 {missing} 个标记没写修改要求</span>
        ) : null}
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button disabled={missing > 0} onClick={() => onConfirm(target, marks)}>
          {marks.length ? `完成标记（${marks.length} 处）` : '不标记，直接带入对话'}
        </Button>
      </div>
      <Button variant="ghost" iconOnly leadingIcon={XIcon} className="jl-dialog-close absolute top-3 right-3" aria-label="关闭" onClick={onCancel} />
    </>
  )
}

export function AnnotateDialog({ target, onCancel, onConfirm }: Props) {
  return (
    <Modal open={target != null} onOpenChange={(open) => !open && onCancel()} className="fixed inset-0 z-50 m-auto flex h-fit max-h-[94dvh] w-[min(96vw,60rem)] flex-col gap-3 rounded-2xl bg-background p-4 shadow-xl outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          {target ? <Body key={target.url} target={target} onCancel={onCancel} onConfirm={onConfirm} /> : null}
        </Modal>
  )
}
