import type React from 'react'
import { AlertTriangle, CheckCircle } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  formatCompactDuration,
  formatResetAt,
  formatResetCountdown,
  toEpochMs,
} from '@/lib/usage-format'
import { computeUsagePace, type UsagePace } from '@/lib/usage-pace'
import { cn } from '@/lib/utils'

export interface UsageWindow {
  usedPercent: number
  resetsAt: number | null
  limitWindowSeconds?: number | null
}

export interface UsageWindowSpec {
  key: string
  label: string
  usage: UsageWindow | null
  /** Window length; falls back to `usage.limitWindowSeconds`. */
  windowSeconds?: number | null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** Meter severity: neutral → warning → danger. */
function severityTextClass(usedPercent: number): string {
  if (usedPercent >= 90) return 'text-destructive'
  if (usedPercent >= 70) return 'text-warning'
  return 'text-foreground/70'
}

function paceFor(
  spec: UsageWindowSpec & { usage: UsageWindow },
  nowMs: number
) {
  return computeUsagePace(
    spec.usage.usedPercent,
    spec.usage.resetsAt,
    spec.windowSeconds ?? spec.usage.limitWindowSeconds,
    nowMs
  )
}

/** Window edge label: time of day, plus weekday for multi-day windows. */
function formatEdge(ms: number, pace: UsagePace): string {
  const multiDay = pace.endMs - pace.startMs >= 24 * 3600 * 1000
  return new Date(ms).toLocaleString(undefined, {
    ...(multiDay ? { weekday: 'short' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
  })
}

function PaceBadge({
  pace,
  usedPercent,
}: {
  pace: UsagePace
  usedPercent: number
}) {
  const atLimit = usedPercent >= 100
  const over = pace.status === 'over'
  const Icon = over ? AlertTriangle : CheckCircle
  const label = atLimit
    ? 'Limit reached'
    : over
      ? 'Over pace'
      : pace.status === 'under'
        ? 'Under pace'
        : 'On pace'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-2xs font-medium',
        atLimit
          ? 'text-destructive'
          : over
            ? 'text-warning'
            : 'text-muted-foreground'
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  )
}

/**
 * Usage across the window: the average rate so far (solid), its projection to
 * reset (dashed), and an even burn rate for reference (gray diagonal).
 */
function UsagePaceChart({
  label,
  usedPercent,
  pace,
}: {
  label: string
  usedPercent: number
  pace: UsagePace
}) {
  const nowX = pace.elapsed * 100
  const projected = pace.projectedPercent
  // The projection stops at reset, or where it crosses the limit.
  const hitsLimit = projected !== null && projected > 100
  const endX = hitsLimit ? (nowX * 100) / usedPercent : 100
  const endY = projected === null ? null : Math.min(100, projected)
  const y = (percent: number) => 100 - percent
  // Next to the "now" dot, the limit dot is only noise; the text says when.
  const showLimitDot = hitsLimit && (endX - nowX > 10 || 100 - usedPercent > 15)

  const summary = [
    `${Math.round(usedPercent)}% used`,
    `${Math.round(pace.elapsed * 100)}% of window elapsed`,
    `even pace ${Math.round(pace.expectedPercent)}%`,
    projected !== null
      ? hitsLimit
        ? 'limit before reset at this rate'
        : `~${Math.round(projected)}% at reset at this rate`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          aria-label={`${label}: ${summary}`}
          className={cn(
            'relative h-16 w-full rounded-md bg-secondary/40',
            severityTextClass(usedPercent)
          )}
        >
          <svg
            className="absolute inset-0 size-full overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            <line
              x1="0"
              y1="50"
              x2="100"
              y2="50"
              className="stroke-border"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="0"
              y1="100"
              x2="100"
              y2="0"
              className="stroke-muted-foreground/40"
              strokeWidth="1.5"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={nowX}
              y1="0"
              x2={nowX}
              y2="100"
              className="stroke-border"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <polygon
              points={`0,100 ${nowX},${y(usedPercent)} ${nowX},100`}
              fill="currentColor"
              fillOpacity="0.25"
            />
            <line
              x1="0"
              y1="100"
              x2={nowX}
              y2={y(usedPercent)}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {endY !== null ? (
              <line
                x1={nowX}
                y1={y(usedPercent)}
                x2={endX}
                y2={y(endY)}
                stroke="currentColor"
                strokeOpacity="0.6"
                strokeWidth="2"
                strokeDasharray="4 3"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {showLimitDot ? (
            <span
              className="absolute top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-destructive ring-2 ring-background"
              style={{ left: `${endX}%` }}
              aria-hidden
            />
          ) : null}
          <span
            className="absolute size-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-current ring-2 ring-background"
            style={{ left: `${nowX}%`, bottom: `${usedPercent}%` }}
            aria-hidden
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>{summary}</TooltipContent>
    </Tooltip>
  )
}

function UsageMeter({
  label,
  usedPercent,
  pace,
  size = 'sm',
}: {
  label: string
  usedPercent: number
  pace: UsagePace | null
  size?: 'sm' | 'md'
}) {
  return (
    <div
      className={cn(
        'relative w-full rounded-full bg-secondary',
        size === 'md' ? 'h-2' : 'h-1.5'
      )}
      role="progressbar"
      aria-valuenow={Math.round(usedPercent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label} ${usedPercent.toFixed(1)}% used`}
    >
      <div
        className={cn(
          'h-full rounded-full bg-current transition-[width] duration-300',
          severityTextClass(usedPercent)
        )}
        style={{ width: `${usedPercent}%` }}
      />
      {pace ? (
        <span
          className="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/50"
          style={{ left: `${pace.expectedPercent}%` }}
          title={`Even pace: ${Math.round(pace.expectedPercent)}%`}
          aria-hidden
        />
      ) : null}
    </div>
  )
}

function ResetLine({
  resetsAt,
  nowMs,
  children,
}: {
  resetsAt: number | null
  nowMs: number
  children?: React.ReactNode
}) {
  if (!resetsAt) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <p className="truncate text-2xs tabular-nums text-muted-foreground">
          Resets in {formatResetCountdown(resetsAt, nowMs)}
          <span className="mx-1.5 text-border" aria-hidden>
            ·
          </span>
          {formatResetAt(resetsAt, nowMs)}
          {children}
        </p>
      </TooltipTrigger>
      <TooltipContent>
        {`Resets ${new Date(toEpochMs(resetsAt)).toLocaleString()}`}
      </TooltipContent>
    </Tooltip>
  )
}

function projectionText(pace: UsagePace, usedPercent: number, nowMs: number) {
  if (usedPercent >= 100) return null
  if (pace.limitAtMs !== null) {
    return `Limit in ~${formatCompactDuration(pace.limitAtMs - nowMs)} at this rate`
  }
  if (pace.projectedPercent !== null) {
    return `~${Math.round(pace.projectedPercent)}% at reset at this rate`
  }
  return null
}

/** Headline window: big percent, pace chart, reset + projection. */
function UsageTile({
  spec,
  nowMs,
}: {
  spec: UsageWindowSpec & { usage: UsageWindow }
  nowMs: number
}) {
  const usedPercent = clampPercent(spec.usage.usedPercent)
  const pace = paceFor(spec, nowMs)
  const projection = pace ? projectionText(pace, usedPercent, nowMs) : null

  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
      <span className="block truncate text-xs text-muted-foreground">
        {spec.label}
      </span>
      <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {Math.round(usedPercent)}%
        <span className="ml-1 text-xs font-normal tracking-normal text-muted-foreground">
          used
        </span>
      </p>
      {pace ? (
        <div className="space-y-1">
          <UsagePaceChart
            label={spec.label}
            usedPercent={usedPercent}
            pace={pace}
          />
          <div className="flex justify-between text-2xs tabular-nums text-muted-foreground">
            <span>{formatEdge(pace.startMs, pace)}</span>
            <span>{formatEdge(pace.endMs, pace)}</span>
          </div>
        </div>
      ) : (
        <UsageMeter
          label={spec.label}
          usedPercent={usedPercent}
          pace={null}
          size="md"
        />
      )}
      <div className="space-y-0.5">
        <ResetLine resetsAt={spec.usage.resetsAt} nowMs={nowMs} />
        {projection ? (
          <p
            className={cn(
              'truncate text-2xs tabular-nums',
              pace?.limitAtMs !== null
                ? 'font-medium text-warning'
                : 'text-muted-foreground'
            )}
          >
            {projection}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Secondary window: label + % used, meter with even-pace tick, reset. */
function UsageRow({
  spec,
  nowMs,
}: {
  spec: UsageWindowSpec & { usage: UsageWindow }
  nowMs: number
}) {
  const usedPercent = clampPercent(spec.usage.usedPercent)
  const pace = paceFor(spec, nowMs)

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-foreground">{spec.label}</span>
        <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
          {Math.round(usedPercent)}%
          <span className="ml-1 font-normal text-muted-foreground">used</span>
        </span>
      </div>
      <UsageMeter label={spec.label} usedPercent={usedPercent} pace={pace} />
      <ResetLine resetsAt={spec.usage.resetsAt} nowMs={nowMs}>
        {pace ? (
          <>
            <span className="mx-1.5 text-border" aria-hidden>
              ·
            </span>
            <PaceBadge pace={pace} usedPercent={usedPercent} />
          </>
        ) : null}
      </ResetLine>
    </div>
  )
}

function hasUsage(
  spec: UsageWindowSpec
): spec is UsageWindowSpec & { usage: UsageWindow } {
  return spec.usage !== null
}

/** Headline windows as tiles with pace charts, the rest as compact meters. */
export function UsageWindows({
  primary,
  secondary = [],
  nowMs,
}: {
  primary: UsageWindowSpec[]
  secondary?: UsageWindowSpec[]
  nowMs: number
}) {
  const withUsage = primary.filter(hasUsage)
  // A tile without a chart beside one with a chart leaves an empty box, so
  // move it to the compact rows. Keep tiles when none of them has a chart.
  const charted = withUsage.filter(spec => paceFor(spec, nowMs) !== null)
  const tiles = charted.length > 0 ? charted : withUsage
  const rows = [
    ...withUsage.filter(spec => !tiles.includes(spec)),
    ...secondary.filter(hasUsage),
  ]

  return (
    <div className="space-y-4">
      {tiles.length > 0 ? (
        <div className={cn('grid gap-3', tiles.length > 1 && 'sm:grid-cols-2')}>
          {tiles.map(spec => (
            <UsageTile key={spec.key} spec={spec} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="space-y-3">
          {rows.map(spec => (
            <UsageRow key={spec.key} spec={spec} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Key for the pace chart marks, shown once above the backend cards. */
export function UsageChartLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs text-muted-foreground sm:px-2">
      <span className="inline-flex items-center gap-1.5">
        <svg
          className="h-2 w-4 text-foreground/70"
          viewBox="0 0 16 8"
          aria-hidden
        >
          <line
            x1="1"
            y1="4"
            x2="15"
            y2="4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Average rate
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg
          className="h-2 w-4 text-foreground/70"
          viewBox="0 0 16 8"
          aria-hidden
        >
          <line
            x1="1"
            y1="4"
            x2="15"
            y2="4"
            stroke="currentColor"
            strokeOpacity="0.6"
            strokeWidth="2"
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
        </svg>
        Projection
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg className="h-2 w-4" viewBox="0 0 16 8" aria-hidden>
          <line
            x1="1"
            y1="4"
            x2="15"
            y2="4"
            className="stroke-muted-foreground/40"
            strokeWidth="1.5"
            strokeDasharray="2 3"
          />
        </svg>
        Even pace
      </span>
    </div>
  )
}
