import { Brain } from '@/components/icons/reicon'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface ReasoningLevelOption {
  value: string
  label: string
  description?: string
  tokens?: string
}

const TRIGGER_CLASS =
  'flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50'

interface ReasoningLevelDropdownProps {
  value: string
  options: readonly ReasoningLevelOption[]
  onValueChange: (value: string) => void
  /** Prefix for the trigger's accessible name, e.g. "Effort" */
  label?: string
  /** Also show the label in the trigger (forms with several pickers) */
  showLabel?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Highlights the brain icon (a level that thinks is selected) */
  active?: boolean
  tooltip?: string
  /** Number hints for the 1-9 shortcuts inside the open menu */
  showShortcuts?: boolean
  disabled?: boolean
  triggerClassName?: string
  align?: 'start' | 'end'
  contentClassName?: string
  onCloseAutoFocus?: (event: Event) => void
}

/** Effort or thinking level picker used by the chat toolbar and agent forms. */
export function ReasoningLevelDropdown({
  value,
  options,
  onValueChange,
  label,
  showLabel = false,
  open,
  onOpenChange,
  active = true,
  tooltip,
  showShortcuts = false,
  disabled,
  triggerClassName,
  align = 'start',
  contentClassName,
  onCloseAutoFocus,
}: ReasoningLevelDropdownProps) {
  const selectedLabel =
    options.find(option => option.value === value)?.label ?? value
  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        disabled={disabled}
        aria-label={label ? `${label}: ${selectedLabel}` : undefined}
        className={cn(TRIGGER_CLASS, triggerClassName)}
      >
        <Brain
          className={cn(
            'h-3.5 w-3.5',
            active && 'text-purple-600 dark:text-purple-400'
          )}
        />
        {showLabel && label && (
          <span className="text-muted-foreground">{label}</span>
        )}
        <span className={cn(showLabel && 'text-foreground')}>
          {selectedLabel}
        </span>
      </button>
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent
        align={align}
        className={contentClassName}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {options.map((option, i) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <Brain className="mr-2 h-4 w-4" />
              {option.label}
              {(option.tokens ?? option.description) && (
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  {option.tokens ?? option.description}
                </span>
              )}
              {showShortcuts && <Kbd className="ml-2 text-[10px]">{i + 1}</Kbd>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
