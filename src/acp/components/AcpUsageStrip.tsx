import { useEffect, useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import type { AcpUsage } from '../store/acp-store'

/**
 * Compact, right-aligned status strip riding above the composer textarea.
 * Shows the running chat cost (formatted in the user's locale via
 * `Intl.NumberFormat`) and the current context utilization. Clicking the
 * pill opens a popover with a richer breakdown panel including a
 * progress bar. Renders nothing when neither value has been reported yet
 * — keeps the composer clean for fresh sessions.
 *
 * NB: Popover (click) instead of Tooltip (hover) — a hover trigger that
 * spans the full composer width fired the panel any time the cursor
 * crossed the row, even far from the text. Popover gives a precise
 * click target and dismisses on outside-click.
 */
export function AcpUsageStrip({
  usage,
  onClose,
  shortcut,
}: {
  usage: AcpUsage
  /** Fired after the popover finishes closing. */
  onClose?: () => void
  /** Optional keyboard shortcut that toggles the popover. */
  shortcut?: { display: string; match: (e: KeyboardEvent) => boolean }
}) {
  const [open, setOpen] = useState(false)
  const pct =
    usage.size && usage.used !== undefined
      ? Math.round((usage.used / usage.size) * 100)
      : undefined
  const cost =
    usage.costAmount !== undefined
      ? formatUsageCost(usage.costAmount, usage.costCurrency)
      : undefined

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(false)
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, onClose])

  useEffect(() => {
    if (!shortcut) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (shortcut.match(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [shortcut])

  if (pct === undefined && cost === undefined) return null

  const pctColor = contextSeverityClass(pct)

  return (
    <div className="flex justify-end px-4 pt-1.5 md:px-6">
      <Popover
        open={open}
        onOpenChange={next => {
          setOpen(next)
          if (!next) onClose?.()
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Show session cost and context details"
                className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {cost ? <span>{cost}</span> : null}
                {cost && pct !== undefined ? (
                  <span aria-hidden className="text-muted-foreground/40">
                    ·
                  </span>
                ) : null}
                {pct !== undefined ? (
                  <span className={pctColor}>{pct}%</span>
                ) : null}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <span className="flex items-center gap-2">
              Session usage
              {shortcut ? <Kbd>{shortcut.display}</Kbd> : null}
            </span>
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="end" className="w-64 p-3">
          <UsageBreakdown usage={usage} pct={pct} cost={cost} />
        </PopoverContent>
      </Popover>
    </div>
  )
}

/**
 * Compact popover body. Hides session cost entirely when unavailable.
 * Context usage is shown as `used / size` on the left with percentage
 * aligned to the right on the same row above the progress bar.
 */
function UsageBreakdown({
  usage,
  pct,
  cost,
}: {
  usage: AcpUsage
  pct: number | undefined
  cost: string | undefined
}) {
  const used = usage.used
  const size = usage.size
  const barColor = contextBarClass(pct)
  const pctColor = contextSeverityClass(pct)
  return (
    <div className="space-y-3 font-sans text-xs">
      {cost ? (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-foreground">Session cost</span>
            <span className="font-mono tabular-nums text-foreground">
              {cost}
            </span>
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <div className="font-medium text-foreground">Context</div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono tabular-nums text-muted-foreground">
            {used !== undefined && size !== undefined
              ? `${formatTokens(used)} / ${formatTokens(size)}`
              : '—'}
          </span>
          <span
            className={cn(
              'font-mono tabular-nums',
              pctColor ?? 'text-muted-foreground'
            )}
          >
            {pct !== undefined ? `${pct}%` : '—'}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full transition-all', barColor)}
            style={{ width: `${Math.min(100, pct ?? 0)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

/** Trigger-level color: orange when context >50%, red when >75%, else
 *  inherit the muted strip color (returns `undefined`). */
function contextSeverityClass(pct: number | undefined): string | undefined {
  if (pct === undefined) return undefined
  if (pct > 75) return 'text-red-600 dark:text-red-400'
  if (pct > 50) return 'text-orange-600 dark:text-orange-400'
  return undefined
}

/** Bar fill color — neutral by default, then warning/error as usage
 *  climbs. Kept a touch bolder so the bar stays legible on the popover
 *  surface. */
function contextBarClass(pct: number | undefined): string {
  if (pct === undefined) return 'bg-muted-foreground/40'
  if (pct > 75) return 'bg-red-500'
  if (pct > 50) return 'bg-orange-500'
  return 'bg-muted-foreground/60'
}

/** Format `amount` in the user's current locale. When the agent provided
 *  a currency code we render it with `style: 'currency'` so the locale
 *  picks the right symbol/placement; without one we fall back to a plain
 *  2-decimal number — assuming USD would be wrong as often as right. */
function formatUsageCost(amount: number, currency: string | undefined): string {
  return new Intl.NumberFormat(
    undefined,
    currency
      ? {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  ).format(amount)
}

/** Compact token counts for the breakdown — `123,456` for under a
 *  million, `1.2M` above. Locale-aware grouping for readability. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return new Intl.NumberFormat(undefined).format(n)
}
