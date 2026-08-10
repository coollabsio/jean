import { ClipboardList, Hammer, ShieldCheck, Zap } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ExecutionMode } from '@/types/chat'
import { cn } from '@/lib/utils'

interface ExecutionModeDropdownProps {
  executionMode: ExecutionMode
  availableModes?: ExecutionMode[]
  disabled?: boolean
  onSetExecutionMode: (mode: ExecutionMode) => void
  className?: string
  align?: 'start' | 'center' | 'end'
  onCloseAutoFocus?: (event: Event) => void
}

const MODE_META: Record<
  ExecutionMode,
  {
    label: string
    description: string
    icon: typeof ClipboardList
    iconClassName?: string
    itemClassName?: string
  }
> = {
  plan: {
    label: 'Plan',
    description: 'Read-only',
    icon: ClipboardList,
    iconClassName: 'text-yellow-600 dark:text-yellow-400',
  },
  build: {
    label: 'Build',
    description: 'Auto-edits',
    icon: Hammer,
  },
  auto: {
    label: 'Auto',
    description: 'Safety-checked',
    icon: ShieldCheck,
    iconClassName: 'text-blue-600 dark:text-blue-400',
  },
  yolo: {
    label: 'Yolo',
    description: 'No limits!',
    icon: Zap,
    iconClassName: 'text-red-500 dark:text-red-400',
    itemClassName:
      'text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400',
  },
}

export function ExecutionModeDropdown({
  executionMode,
  availableModes = ['plan', 'build', 'auto', 'yolo'],
  disabled = false,
  onSetExecutionMode,
  className,
  align = 'start',
  onCloseAutoFocus,
}: ExecutionModeDropdownProps) {
  const activeMode = MODE_META[executionMode]
  const ActiveIcon = activeMode.icon

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                'flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                className
              )}
            >
              <ActiveIcon
                className={cn('h-3.5 w-3.5', activeMode.iconClassName)}
              />
              <span>{activeMode.label}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{`${activeMode.label} mode (Shift+Tab to cycle)`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuRadioGroup
          value={executionMode}
          onValueChange={value => onSetExecutionMode(value as ExecutionMode)}
        >
          {availableModes.map(mode => {
            const meta = MODE_META[mode]
            const Icon = meta.icon
            return (
              <div key={mode}>
                {mode === 'yolo' && <DropdownMenuSeparator />}
                <DropdownMenuRadioItem
                  value={mode}
                  className={meta.itemClassName}
                >
                  <Icon className={cn('mr-2 h-4 w-4', meta.iconClassName)} />
                  {meta.label}
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">
                    {meta.description}
                  </span>
                </DropdownMenuRadioItem>
              </div>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
