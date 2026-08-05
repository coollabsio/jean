import { Loader2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface BulkInvestigateBarProps {
  count: number
  isLoading?: boolean
  noun?: string
  onClear: () => void
  onInvestigate: () => void
}

/** Sticky footer action bar for multi-select bulk investigate in New Session tabs. */
export function BulkInvestigateBar({
  count,
  isLoading = false,
  noun = 'items',
  onClear,
  onInvestigate,
}: BulkInvestigateBarProps) {
  return (
    <div className="shrink-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 py-2.5 sm:py-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
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
        className="w-full sm:w-auto sm:ml-auto"
        disabled={isLoading}
        onClick={onInvestigate}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Wand2 className="h-4 w-4 text-current dark:text-yellow-400" />
        )}
        {isLoading
          ? 'Starting…'
          : `Investigate ${count} ${noun} in background`}
      </Button>
    </div>
  )
}
