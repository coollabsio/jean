import { memo } from 'react'
import { Gauge } from 'lucide-react'
import type { UsageData } from '@/types/chat'
import { formatTokens } from '@/lib/session-debug'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface SessionUsageChipProps {
  latestUsage?: UsageData
  totalUsage?: UsageData
}

export function getContextTokenCount(usage: UsageData): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

function UsageRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatTokens(value)}</span>
    </div>
  )
}

export const SessionUsageChip = memo(function SessionUsageChip({
  latestUsage,
  totalUsage,
}: SessionUsageChipProps) {
  if (!latestUsage) return null

  const contextTokens = getContextTokenCount(latestUsage)
  if (contextTokens === 0) return null

  const totals = totalUsage ?? latestUsage

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="status"
          tabIndex={0}
          aria-label={`${formatTokens(contextTokens)} context tokens`}
          className="hidden @xl:flex h-7 shrink-0 cursor-default items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Gauge className="size-3" aria-hidden="true" />
          <span className="font-mono tabular-nums">
            {formatTokens(contextTokens)} ctx
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="w-56 space-y-2 p-3">
        <div className="flex items-center justify-between gap-6 font-medium">
          <span>Last-turn context</span>
          <span className="font-mono tabular-nums">
            {formatTokens(contextTokens)}
          </span>
        </div>
        <div className="border-t border-border/60 pt-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Session totals
          </div>
          <div className="space-y-1">
            <UsageRow label="Input" value={totals.input_tokens} />
            <UsageRow label="Output" value={totals.output_tokens} />
            <UsageRow
              label="Cache read"
              value={totals.cache_read_input_tokens ?? 0}
            />
            <UsageRow
              label="Cache creation"
              value={totals.cache_creation_input_tokens ?? 0}
            />
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
})
