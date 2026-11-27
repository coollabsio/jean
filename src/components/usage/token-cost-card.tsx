import { useState } from 'react'
import { BarChart3, Loader2 } from '@/components/icons/reicon'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BackendLabel, getBackendIcon } from '@/components/ui/backend-label'
import { useUsageSummary } from '@/services/usage-summary'
import { formatTokens } from '@/lib/session-debug'
import {
  cacheSavingsUsd,
  rowCost,
  usageTotals,
  type RowCost,
} from '@/lib/model-pricing'

const PERIODS = [
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
  { value: 'all', label: 'All', days: null },
] as const

type Period = (typeof PERIODS)[number]['value']

function formatUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`
}

function CostCell({ cost }: { cost: RowCost | null }) {
  if (!cost) return <span className="text-muted-foreground">—</span>
  return (
    <>
      {formatUsd(cost.usd)}
      {cost.estimated ? (
        <span className="ml-1 text-2xs text-muted-foreground">est.</span>
      ) : null}
    </>
  )
}

const cell = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'

/** Token totals, API-price cost and cache savings per backend + model. */
export function TokenCostCard() {
  const [period, setPeriod] = useState<Period>('30')
  const days = PERIODS.find(p => p.value === period)?.days ?? null
  const summary = useUsageSummary(days)
  const rows = [...(summary.data ?? [])].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
  )
  const totals = usageTotals(rows)

  return (
    <section id="pref-usage-section-tokens" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BarChart3 className="size-4 shrink-0" />
          Tokens &amp; cost
        </h3>
        <ToggleGroup
          type="single"
          value={period}
          onValueChange={value => {
            if (value) setPeriod(value as Period)
          }}
          aria-label="Usage period"
          size="sm"
          className="gap-0.5 rounded-md bg-muted p-0.5"
        >
          {PERIODS.map(p => (
            <ToggleGroupItem
              key={p.value}
              value={p.value}
              className="rounded-sm px-3 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
            >
              {p.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {summary.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading token usage…
        </div>
      ) : summary.error ? (
        <p className="text-xs text-destructive">
          Failed to load token usage: {String(summary.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No runs with token usage in this period.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Model</th>
                <th className={`${cell} font-medium`}>Runs</th>
                <th className={`${cell} font-medium`}>Input</th>
                <th className={`${cell} font-medium`}>Output</th>
                <th className={`${cell} font-medium`}>Cache read</th>
                <th className={`${cell} font-medium`}>Cache write</th>
                <th className={`${cell} font-medium`}>Cost</th>
                <th className={`${cell} font-medium`}>Cache saved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const Icon = getBackendIcon(row.backend)
                const savings = cacheSavingsUsd(row)
                return (
                  <tr
                    key={`${row.backend}:${row.model ?? ''}`}
                    className="border-t"
                  >
                    <td className="px-2 py-1.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3.5 shrink-0" />
                        <BackendLabel
                          backend={row.backend}
                          className="shrink-0"
                        />
                        <span className="truncate text-muted-foreground">
                          {row.model ?? 'Unknown model'}
                        </span>
                      </div>
                    </td>
                    <td className={cell}>{row.runCount}</td>
                    <td className={cell}>{formatTokens(row.inputTokens)}</td>
                    <td className={cell}>{formatTokens(row.outputTokens)}</td>
                    <td className={cell}>
                      {formatTokens(row.cacheReadInputTokens)}
                    </td>
                    <td className={cell}>
                      {formatTokens(row.cacheCreationInputTokens)}
                    </td>
                    <td className={cell}>
                      <CostCell cost={rowCost(row)} />
                    </td>
                    <td className={cell}>
                      {savings === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatUsd(savings)
                      )}
                    </td>
                  </tr>
                )
              })}
              <tr className="border-t bg-muted/30 font-medium">
                <td className="px-2 py-1.5">Total</td>
                <td className={cell}>
                  {rows.reduce((sum, row) => sum + row.runCount, 0)}
                </td>
                <td className={cell}>{formatTokens(totals.inputTokens)}</td>
                <td className={cell}>{formatTokens(totals.outputTokens)}</td>
                <td className={cell}>
                  {formatTokens(totals.cacheReadInputTokens)}
                </td>
                <td className={cell}>
                  {formatTokens(totals.cacheCreationInputTokens)}
                </td>
                <td className={cell}>
                  <CostCell
                    cost={{ usd: totals.costUsd, estimated: totals.estimated }}
                  />
                </td>
                <td className={cell}>{formatUsd(totals.savingsUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="text-2xs text-muted-foreground">
        Estimated at API prices; subscription plans are billed differently.
        {totals.partial
          ? ' Models without a known price (—) are left out of the total.'
          : ''}
      </p>
    </section>
  )
}
