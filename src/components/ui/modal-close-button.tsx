import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ModalCloseButtonProps {
  onClick: (e: React.MouseEvent) => void
  /** sm = panels/drawers, md = modals (default), lg = preferences mobile */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeMap = {
  sm: { button: 'h-6 w-6', icon: 'h-3.5 w-3.5' },
  md: { button: 'h-7 w-7', icon: 'h-4 w-4' },
  lg: { button: 'h-9 w-9', icon: 'h-4 w-4' },
} as const

/**
 * Reusable close button for modals, dialogs, drawers, and panel headers.
 * For inline chip/tag removal, use DismissButton instead.
 */
export function ModalCloseButton({
  onClick,
  size = 'md',
  className,
}: ModalCloseButtonProps) {
  const s = sizeMap[size]

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(s.button, 'shrink-0 p-0', className)}
      onClick={onClick}
    >
      <X className={s.icon} />
    </Button>
  )
}
