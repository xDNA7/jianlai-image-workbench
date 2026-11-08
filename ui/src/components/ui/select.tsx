import { Select as AriaSelect, SelectValue, ListBox, ListBoxItem, Popover, Button as AriaButton } from 'react-aria-components'
import { ChevronDown } from 'lucide-react'

export function SelectField({ label, items, value, onChange, disabled }: { label: string; items: Array<{ id: string; label: string }>; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <AriaSelect aria-label={label} selectedKey={value} onSelectionChange={key => onChange(String(key))} isDisabled={disabled} className="field select-field">
    <span className="field-label">{label}</span><AriaButton className="field-control select-trigger"><SelectValue/><ChevronDown size={16}/></AriaButton>
    <Popover className="select-popover" placement="bottom start"><ListBox className="select-list">{items.map(item=><ListBoxItem key={item.id} id={item.id} textValue={item.label} className="select-option">{item.label}</ListBoxItem>)}</ListBox></Popover>
  </AriaSelect>
}
