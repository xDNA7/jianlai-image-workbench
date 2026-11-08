import { Dialog, DialogTrigger, Modal, ModalOverlay, Button } from 'react-aria-components'
import type { ReactNode } from 'react'

export function AccessibleDialog({ trigger, title, children }: { trigger: ReactNode; title: string; children: ReactNode }) {
  return <DialogTrigger><Button className="dialog-trigger">{trigger}</Button><ModalOverlay className="dialog-overlay"><Modal className="dialog-modal"><Dialog className="dialog-content"><h2>{title}</h2>{children}</Dialog></Modal></ModalOverlay></DialogTrigger>
}
