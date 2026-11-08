/** Position marks the user places on an image before asking for an edit. */
export type Mark = {
  id: string
  type: 'point' | 'area'
  /** All coordinates are fractions (0..1) of the original image. */
  x: number
  y: number
  w: number
  h: number
  note: string
}

export const MAX_MARKS = 12
export const NOTE_MAX = 500
/** Smallest box edge (fraction of the image) that counts as a drag, not a click. */
export const MIN_BOX = 0.008

export type ApiAnnotation =
  | { type: 'point'; x: number; y: number; text: string }
  | { type: 'box'; x: number; y: number; w: number; h: number; text: string }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Pointer position inside a frame, as fractions of the frame. */
export function pointIn(
  bounds: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
) {
  return {
    x: clamp01((clientX - bounds.left) / bounds.width),
    y: clamp01((clientY - bounds.top) / bounds.height),
  }
}

/** A drag from `a` to `b` as a box, or null when it is too small to be one. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  const box = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
  return box.w > MIN_BOX && box.h > MIN_BOX ? box : null
}

export function newMark(partial: Pick<Mark, 'type' | 'x' | 'y'> & Partial<Pick<Mark, 'w' | 'h'>>): Mark {
  return { id: crypto.randomUUID(), w: 0, h: 0, note: '', ...partial }
}

/** Marks without a note cannot be sent; the editor asks the user to fill or delete them. */
export function incompleteCount(marks: Mark[]) {
  return marks.filter((m) => !m.note.trim()).length
}

/** The shape `/api/generate` validates: boxes stay inside the image, notes are 1..500 chars. */
export function toApiAnnotations(marks: Mark[]): ApiAnnotation[] {
  return marks
    .filter((m) => m.note.trim())
    .slice(0, MAX_MARKS)
    .map((m): ApiAnnotation => {
      const text = m.note.trim().slice(0, NOTE_MAX)
      if (m.type === 'point') return { type: 'point', x: clamp01(m.x), y: clamp01(m.y), text }
      const x = clamp01(m.x)
      const y = clamp01(m.y)
      return { type: 'box', x, y, w: Math.min(m.w, 1 - x), h: Math.min(m.h, 1 - y), text }
    })
}

/** Text used for the message when the user marks places but writes nothing else. */
export const DEFAULT_EDIT_TEXT = '按标记修改这张图'

/** `/api/chat` keeps only the first 2000 Unicode characters of a reference prompt. */
export function referencePromptWithMarks(prompt: string, marks: Mark[] = []): string {
  const limit = 2000
  const chars = (text: string) => Array.from(text)
  const annotations = toApiAnnotations(marks).map((annotation) => {
    const rounded = Object.fromEntries(Object.entries(annotation).map(([key, value]) =>
      [key, typeof value === 'number' ? Math.round(value * 10000) / 10000 : value]))
    return { ...rounded, text: annotation.text }
  })
  if (!annotations.length) return chars(prompt).slice(0, limit).join('')
  // Keep some source context, reserving the remaining space for every marked instruction.
  const header = `${chars(prompt).slice(0, 400).join('')}\n标记修改要求（坐标为原图的0..1比例）：\n`
  const serialize = (noteLimit: number) => header + JSON.stringify(annotations.map((annotation) => ({
    ...annotation, text: chars(annotation.text).slice(0, noteLimit).join(''),
  })))
  // JSON escaping also consumes the server's character budget; measure the actual payload.
  let low = 0
  let high = NOTE_MAX
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (chars(serialize(middle)).length <= limit) low = middle
    else high = middle - 1
  }
  return serialize(low)
}
