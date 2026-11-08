import { cn } from '../../lib/utils'

function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('rounded-md border border-neutral-200 bg-white text-neutral-950', className)} {...props} />
}
export { Card }
