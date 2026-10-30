import { Loader2, Wand2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

export interface BulkInvestigateBarProps {
  count: number
  isLoading?: boolean
  noun?: string
  /** Replaces the default "Investigate N items in background" label */
  actionLabel?: string
  /** Optional second action shown after the main button */
  secondaryActionLabel?: string
  onSecondaryAction?: () => void
  /** Keyboard shortcut hints shown inside the action buttons */
  actionKbd?: string
  secondaryActionKbd?: string
  onClear: () => void
  onInvestigate: () => void
  className?: string
}

/** Sticky footer action bar for multi-select bulk investigate in New Session tabs. */
export function BulkInvestigateBar({
  count,
  isLoading = false,
  noun = 'items',
  actionLabel,
  secondaryActionLabel,
  onSecondaryAction,
  actionKbd,
  secondaryActionKbd,
  onClear,
  onInvestigate,
  className,
}: BulkInvestigateBarProps) {
  return (
    <div
      className={cn(
        // Mobile: keep the action above the home indicator / screen edge
        'shrink-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:py-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3',
        className
      )}
    >
      <div className="flex items-center justify-between sm:justify-start gap-2 min-w-0">
        <span className="text-sm font-medium tabular-nums">
          {count} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={isLoading}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline sm:ml-1"
        >
          Clear
        </button>
      </div>
      <Button
        size="sm"
        className="w-full h-10 sm:h-8 sm:w-auto sm:ml-auto"
        disabled={isLoading}
        onClick={onInvestigate}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Wand2 className="h-4 w-4 text-current" />
        )}
        {isLoading
          ? 'Starting…'
          : (actionLabel ?? `Investigate ${count} ${noun} in background`)}
        {actionKbd && !isLoading && (
          <Kbd className="bg-primary-foreground/15 text-current">
            {actionKbd}
          </Kbd>
        )}
      </Button>
      {secondaryActionLabel && onSecondaryAction && (
        <Button
          size="sm"
          variant="outline"
          className="w-full h-10 sm:h-8 sm:w-auto"
          disabled={isLoading}
          onClick={onSecondaryAction}
        >
          {secondaryActionLabel}
          {secondaryActionKbd && <Kbd>{secondaryActionKbd}</Kbd>}
        </Button>
      )}
    </div>
  )
}
