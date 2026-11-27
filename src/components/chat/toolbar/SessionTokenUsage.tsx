import { Layers } from '@/components/icons/reicon'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'
import { formatTokens } from '@/lib/session-debug'
import { cn } from '@/lib/utils'
import type { UsageData } from '@/types/chat'

/**
 * Prompt size of a turn: fresh input plus cache reads and writes. This is what
 * occupies the model's context window, unlike `input_tokens` alone (Claude
 * reports most of a long conversation as cache reads).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function contextTokenCount(usage?: UsageData | null): number {
  if (!usage) return 0
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto pl-3 font-mono tabular-nums">{value}</span>
    </div>
  )
}

/**
 * Details menu section: the last turn's context size and the session's token
 * totals. Hidden until a run reports usage.
 */
export function SessionTokenUsage({
  latest,
  total,
}: {
  latest?: UsageData | null
  total?: UsageData | null
}) {
  const isMobile = useIsMobile()
  const context = contextTokenCount(latest)
  if (!latest || context === 0) return null

  const totals = total ?? latest
  const cacheRead = totals.cache_read_input_tokens ?? 0
  const cacheWrite = totals.cache_creation_input_tokens ?? 0

  return (
    <>
      <div
        data-testid="thread-details-tokens"
        className={cn(
          'flex items-start gap-2 px-2 py-1.5 text-sm',
          // Match mobile menu item spacing so the icon lines up (App.css)
          isMobile && 'gap-3 px-3'
        )}
      >
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-xs">
          <Row label="Context (last turn)" value={formatTokens(context)} />
          <Row
            label="Session"
            value={`${formatTokens(totals.input_tokens)} in · ${formatTokens(totals.output_tokens)} out`}
          />
          {(cacheRead > 0 || cacheWrite > 0) && (
            <Row
              label="Cache"
              value={`${formatTokens(cacheRead)} read · ${formatTokens(cacheWrite)} write`}
            />
          )}
        </div>
      </div>
      <DropdownMenuSeparator />
    </>
  )
}
