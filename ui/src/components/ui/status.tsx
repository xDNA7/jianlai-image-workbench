import { AlertCircle, CheckCircle2, LoaderCircle, type LucideIcon } from 'lucide-react'

const icons: Record<string, LucideIcon> = { loading:LoaderCircle, error:AlertCircle, success:CheckCircle2 }
export function StatusMessage({ state, children, onRetry }: { state: 'loading'|'error'|'success'|'empty'; children: string; onRetry?: () => void }) {
  const Icon = icons[state]
  return <div className={`status-message status-${state}`} role={state==='error'?'alert':'status'}>{Icon && <Icon size={18} aria-hidden="true"/>}<span>{children}</span>{state==='error' && onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>
}
