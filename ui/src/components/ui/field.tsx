import { FieldError, type InputProps, type TextAreaProps } from 'react-aria-components'
import { TextField as BoardTextField, InputBase } from '../../boardui/input'
import { TextareaBase } from '../../boardui/textarea'
import { Label } from '../../boardui/label'
import { HintText } from '../../boardui/hint-text'
import { cn } from '../../lib/utils'

export function TextField({ label, description, error, className, ...props }: Omit<InputProps, 'size'> & { label: string; description?: string; error?: string }) {
  return <BoardTextField className="field" isInvalid={Boolean(error)}><Label>{label}</Label><InputBase className={cn('field-control', className)} {...props}/>{description && <HintText>{description}</HintText>}{error && <FieldError className="field-error">{error}</FieldError>}</BoardTextField>
}

export function TextAreaField({ label, description, error, className, ...props }: TextAreaProps & { label: string; description?: string; error?: string }) {
  return <BoardTextField className="field" isInvalid={Boolean(error)}><Label>{label}</Label><TextareaBase className={cn('field-control field-area', className)} {...props}/>{description && <HintText>{description}</HintText>}{error && <FieldError className="field-error">{error}</FieldError>}</BoardTextField>
}
