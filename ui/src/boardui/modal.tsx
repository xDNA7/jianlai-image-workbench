import type { ReactNode } from 'react'
import { Dialog, Modal as AriaModal, ModalOverlay } from 'react-aria-components'

/** Project adapter: React Aria owns focus containment/restoration, Escape and scroll lock. */
export function Modal({ open, onOpenChange, children, className, backdropClassName = 'bg-black/60', label }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  className: string
  backdropClassName?: string
  label?: string
}) {
  return <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable className={`jl-modal-backdrop fixed inset-0 z-50 ${backdropClassName}`}>
    <AriaModal className="contents">
      <Dialog aria-label={label} className={`jl-modal-surface ${className}`}>{children}</Dialog>
    </AriaModal>
  </ModalOverlay>
}
