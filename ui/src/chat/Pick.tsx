import { useId, useRef, useState } from 'react'
import { ListBox, ListBoxItem, Popover } from 'react-aria-components'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { Button } from '@/boardui/button'
import type { Option } from './types'

type Props = { label: string; value: string; options: Option[]; onChange: (value: string) => void; disabled?: boolean }

/** BoardUI-styled select-only combobox; React Aria owns popup/listbox focus and keyboard selection. */
export function Pick({ label, value, options, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const selected = options.find(option => option.value === value)
  return <>
    <Button ref={trigger} role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined}
      disabled={disabled} variant="secondary" size="small" trailingIcon={ChevronDownIcon}
      className="jl-select inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm outline-none select-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-[#007aff]/30 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => setOpen(current => !current)} onKeyDown={e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') { e.preventDefault(); setOpen(true) }
        else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const match = options.find(option => option.label.toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()))
          if (match) onChange(match.value)
        }
      }}>
      <span className="truncate">{selected?.label ?? value}</span>
    </Button>
    <Popover triggerRef={trigger} isOpen={open} onOpenChange={setOpen} placement="bottom start" offset={6}
      className="jl-select-menu z-50 min-w-(--trigger-width) rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
      <ListBox id={listId} aria-label={label} autoFocus selectionMode="single" disallowEmptySelection selectedKeys={[value]}
        onSelectionChange={keys => { const next = [...keys][0]; if (next != null) { onChange(String(next)); setOpen(false) } }}
        className="max-h-[min(24rem,70dvh)] overflow-y-auto outline-none">
        {options.map(option => <ListBoxItem key={option.value} id={option.value} textValue={option.label} className="grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-lg px-2 py-2 text-sm outline-none select-none data-focused:bg-muted">
          {({ isSelected }) => <><span>{isSelected ? <CheckIcon aria-hidden="true" className="size-4 text-primary" /> : null}</span><span>{option.label}</span></>}
        </ListBoxItem>)}
      </ListBox>
    </Popover>
  </>
}
