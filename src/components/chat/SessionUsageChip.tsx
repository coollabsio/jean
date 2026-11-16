import { memo } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatTokens } from '@/lib/session-debug'
import type { UsageData } from '@/types/chat'

/**
 * Prompt size of a turn: fresh input plus cache reads and writes. This is what
 * occupies the model's context window, unlike `input_tokens` alone (Claude
 * reports most of a long conversation as cache reads).
 */
export function contextTokenCount(usage?: UsageData | null): number {
  if (!usage) return 0
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/**
 * Compact context-window chip for the chat toolbar.
 *
 * Body: the last turn's context size (`180.0k ctx`).
 * Tooltip: that context plus the session's input/output/cache totals.
 * Hidden until a run reports usage and on narrow toolbars.
 */
export const SessionUsageChip = memo(function SessionUsageChip({
  latest,
  total,
}: {
  latest?: UsageData | null
  total?: UsageData | null
}) {
  const context = contextTokenCount(latest)
  if (!latest || context === 0) return null

  const totals = total ?? latest
  const hasCache =
    (totals.cache_read_input_tokens ?? 0) > 0 ||
    (totals.cache_creation_input_tokens ?? 0) > 0

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="hidden shrink-0 items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground @xl:inline-flex"
          aria-label={`Context ${formatTokens(context)} tokens`}
        >
          {formatTokens(context)} ctx
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="space-y-1 text-xs">
        <p className="font-medium">{formatTokens(context)} context this turn</p>
        <p className="text-muted-foreground">
          Session: {formatTokens(totals.input_tokens)} in ·{' '}
          {formatTokens(totals.output_tokens)} out
        </p>
        {hasCache && (
          <p className="text-muted-foreground">
            Cache: {formatTokens(totals.cache_read_input_tokens ?? 0)} read ·{' '}
            {formatTokens(totals.cache_creation_input_tokens ?? 0)} write
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
})
