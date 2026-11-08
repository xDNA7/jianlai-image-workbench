import type { ButtonHTMLAttributes } from 'react'
import { Button as BoardButton } from '../../boardui/button'

/** BoardUI adapter for existing business surfaces; native type defaults to button. */
export function Button({ variant = 'default', size = 'default', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
}) {
  return <BoardButton {...props} type={type} variant={variant === 'outline' ? 'secondary' : variant === 'ghost' ? 'ghost' : 'primary'} size={size === 'sm' ? 'small' : 'medium'} />
}
