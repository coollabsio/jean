import { X } from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DismissButtonProps {
  /** Tooltip text shown on hover */
  tooltip: string
  /** Click handler */
  onClick: (e: React.MouseEvent) => void
  /** Additional classes for the button wrapper */
  className?: string
  /** Size of the X icon (default: 'sm') */
  size?: 'sm' | 'xs'
}

/**
 * Reusable dismiss/remove button with two-stage hover:
 * 1. Default: subtle muted X icon
 * 2. Hover: red background circle with white X + tooltip
 */
export function DismissButton({
  tooltip,
  onClick,
  className,
  size = 'sm',
}: DismissButtonProps) {
  const iconSize = size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          onClick={onClick}
          className={cn(
            'inline-flex items-center justify-center rounded-full p-0.5 transition-colors',
            'text-muted-foreground hover:bg-destructive/20 hover:text-destructive',
            className
          )}
        >
          <X className={iconSize} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
