import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface SplitButtonProps {
  label: string
  tooltip?: string
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'outline'
  size?: 'sm' | 'default'
  className?: string
  children: React.ReactNode
}

export function SplitButton({
  label,
  tooltip,
  onClick,
  disabled,
  variant = 'default',
  size = 'sm',
  className,
  children,
}: SplitButtonProps) {
  const mainButton = (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      onClick={onClick}
      className={cn('rounded-r-none border-r-0', className)}
    >
      {label}
    </Button>
  )

  return (
    <div className="inline-flex">
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{mainButton}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        mainButton
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size={size}
            disabled={disabled}
            className={cn(
              'rounded-l-none px-1.5',
              variant === 'default'
                ? 'border-l border-l-primary-foreground/20'
                : 'border-l border-l-border',
              className
            )}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{children}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
