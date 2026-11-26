import { Brain, Check, ChevronsUpDown } from '@/components/icons/reicon'
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

const MAX_INLINE_HINT_LENGTH = 24

/** Short hint next to the label. Long catalog sentences go to the tooltip only. */
function inlineHint(option: ReasoningLevelOption): string | undefined {
  if (option.tokens) return option.tokens
  if (!option.description) return undefined
  return option.description.length <= MAX_INLINE_HINT_LENGTH
    ? option.description
    : undefined
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
  /** Text-only trigger, e.g. when it continues the model picker chip */
  hideIcon?: boolean
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
  hideIcon = false,
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
        {!hideIcon && (
          <Brain
            className={cn(
              'h-3.5 w-3.5',
              active && 'text-purple-600 dark:text-purple-400'
            )}
          />
        )}
        {showLabel && label && (
          <span className="text-muted-foreground">{label}</span>
        )}
        <span className={cn(showLabel && 'text-foreground')}>
          {selectedLabel}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
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
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              title={option.description}
            >
              <Brain className="mr-2 h-4 w-4" />
              {option.label}
              {inlineHint(option) && (
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  {inlineHint(option)}
                </span>
              )}
              {showShortcuts && <Kbd className="ml-2 text-2xs">{i + 1}</Kbd>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ReasoningLevelListProps {
  title: string
  subtitle?: string
  value: string
  options: readonly ReasoningLevelOption[]
  onValueChange: (value: string) => void
}

/** Inline effort or thinking column for the model picker popover. */
export function ReasoningLevelList({
  title,
  subtitle,
  value,
  options,
  onValueChange,
}: ReasoningLevelListProps) {
  return (
    <div className="flex w-60 shrink-0 flex-col border-l">
      <div className="flex border-b p-2">
        <div className="flex h-9 min-w-0 flex-1 items-center justify-between gap-2 px-2 text-sm text-muted-foreground">
          <span>{title}</span>
          {subtitle && <span className="truncate text-xs">{subtitle}</span>}
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={title}
        className="flex max-h-[24rem] flex-col gap-0.5 overflow-y-auto p-1"
      >
        {options.map(option => {
          const checked = option.value === value
          const hint = inlineHint(option)
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              title={option.description}
              onClick={() => onValueChange(option.value)}
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                checked && 'bg-accent/60 text-accent-foreground'
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {hint && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {hint}
                </span>
              )}
              <Check
                className={cn(
                  'h-4 w-4 shrink-0',
                  checked ? 'opacity-100' : 'opacity-0'
                )}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
