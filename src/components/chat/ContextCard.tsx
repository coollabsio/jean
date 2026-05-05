import { memo, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  type ContextDetailSection,
  type ContextUsageData,
  formatTokens,
} from './context-usage-utils'

interface ContextCardProps {
  data: ContextUsageData
}

const FREE_SPACE_LABELS = new Set(['free space', 'available'])
const BUFFER_LABELS = new Set(['autocompact buffer'])

const CATEGORY_PALETTE = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-fuchsia-500',
  'bg-lime-500',
  'bg-orange-500',
]

// Subtle muted shade for the "available" / Free space segment so the stacked
// bar fills end-to-end without visually competing with active usage segments.
const FREE_SPACE_COLOR = 'bg-muted-foreground/15'
// Reserved-but-not-used buffer — slightly warmer to read as "set aside".
const BUFFER_COLOR = 'bg-amber-500/40'

function colorForCategory(label: string, index: number): string {
  const lower = label.toLowerCase()
  if (FREE_SPACE_LABELS.has(lower)) return FREE_SPACE_COLOR
  if (BUFFER_LABELS.has(lower)) return BUFFER_COLOR
  return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length] ?? 'bg-primary'
}

function percentBadgeVariant(pct: number): 'muted' | 'outline' | 'destructive' {
  if (pct >= 75) return 'destructive'
  if (pct >= 50) return 'outline'
  return 'muted'
}

interface PreparedCategory {
  label: string
  tokens: number
  percent: number
  color: string
  isFree: boolean
  isBuffer: boolean
}

function prepareCategories(data: ContextUsageData): PreparedCategory[] {
  return data.categories.map((cat, i) => {
    const lower = cat.label.toLowerCase()
    return {
      label: cat.label,
      tokens: cat.tokens,
      percent: cat.percent,
      color: colorForCategory(cat.label, i),
      isFree: FREE_SPACE_LABELS.has(lower),
      isBuffer: BUFFER_LABELS.has(lower),
    }
  })
}

export const ContextCard = memo(function ContextCard({
  data,
}: ContextCardProps) {
  const categories = useMemo(() => prepareCategories(data), [data])

  // Sort categories for the breakdown table: tokens desc, but pin "Free space" last
  const sortedCategories = useMemo(() => {
    return [...categories].sort((a, b) => {
      if (a.isFree && !b.isFree) return 1
      if (b.isFree && !a.isFree) return -1
      return b.tokens - a.tokens
    })
  }, [categories])

  // Stacked bar: include all non-zero categories so the bar fills end-to-end.
  // Order: active usage segments first (in source order), then reserved Buffer,
  // then Free space last — reads naturally as "used | reserved | free".
  const barSegments = useMemo(() => {
    const active: PreparedCategory[] = []
    let buffer: PreparedCategory | null = null
    let free: PreparedCategory | null = null
    for (const cat of categories) {
      if (cat.tokens <= 0) continue
      if (cat.isFree) free = cat
      else if (cat.isBuffer) buffer = cat
      else active.push(cat)
    }
    const ordered = [...active]
    if (buffer) ordered.push(buffer)
    if (free) ordered.push(free)
    return ordered
  }, [categories])

  return (
    <div className="my-1 rounded-lg border border-border bg-card text-card-foreground">
      <Header
        model={data.model}
        tokensUsed={data.tokensUsed}
        tokensTotal={data.tokensTotal}
        percentUsed={data.percentUsed}
      />
      {barSegments.length > 0 && (
        <UsageBar segments={barSegments} totalTokens={data.tokensTotal} />
      )}
      <Collapsible>
        <CollapsibleTrigger
          className={cn(
            'group flex w-full items-center justify-between gap-2 px-3 py-2',
            'text-xs text-muted-foreground hover:text-foreground transition-colors',
            'border-t border-border/60'
          )}
        >
          <span>Breakdown</span>
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-3">
            <CategoryBreakdown categories={sortedCategories} />
            {data.sections.map(section => (
              <DetailSection key={section.title} section={section} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})

function Header({
  model,
  tokensUsed,
  tokensTotal,
  percentUsed,
}: {
  model: string
  tokensUsed: number
  tokensTotal: number
  percentUsed: number
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
          Context Usage
        </div>
        {model && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {model}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {formatTokens(tokensUsed)}
            <span className="text-muted-foreground font-normal">
              {' / '}
              {formatTokens(tokensTotal)}
            </span>
          </div>
        </div>
        <Badge
          variant={percentBadgeVariant(percentUsed)}
          className="tabular-nums"
        >
          {percentUsed}%
        </Badge>
      </div>
    </div>
  )
}

function UsageBar({
  segments,
  totalTokens,
}: {
  segments: PreparedCategory[]
  totalTokens: number
}) {
  if (totalTokens <= 0) return null
  return (
    <div
      className="mx-3 mb-3 flex h-1.5 overflow-hidden rounded-full bg-muted-foreground/5"
      role="img"
      aria-label="Context usage breakdown"
    >
      {segments.map(segment => {
        const widthPct = Math.max(0.5, (segment.tokens / totalTokens) * 100)
        return (
          <Tooltip key={segment.label}>
            <TooltipTrigger asChild>
              <div
                className={cn('h-full', segment.color)}
                style={{ width: `${widthPct}%` }}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {segment.label} · {formatTokens(segment.tokens)} ·{' '}
              {segment.percent}%
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

function CategoryBreakdown({ categories }: { categories: PreparedCategory[] }) {
  return (
    <div className="space-y-1">
      {categories.map(cat => (
        <div key={cat.label} className="flex items-center gap-2 text-xs">
          <span
            className={cn('inline-block size-2 rounded-sm shrink-0', cat.color)}
            aria-hidden
          />
          <span className="flex-1 truncate text-muted-foreground">
            {cat.label}
          </span>
          <span className="tabular-nums text-foreground">
            {formatTokens(cat.tokens)}
          </span>
          <span className="tabular-nums text-muted-foreground/70 w-10 text-right">
            {cat.percent}%
          </span>
        </div>
      ))}
    </div>
  )
}

function DetailSection({ section }: { section: ContextDetailSection }) {
  const [open, setOpen] = useState(false)
  const totalTokens = useMemo(
    () => section.rows.reduce((sum, row) => sum + row.tokens, 0),
    [section.rows]
  )
  const sortedRows = useMemo(
    () => [...section.rows].sort((a, b) => b.tokens - a.tokens),
    [section.rows]
  )

  if (section.rows.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5',
          'text-xs hover:bg-muted/50 transition-colors'
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
          <span className="font-medium text-foreground">{section.title}</span>
          <span className="text-muted-foreground/70">
            ({section.rows.length})
          </span>
        </div>
        <span className="tabular-nums text-muted-foreground shrink-0">
          {formatTokens(totalTokens)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-border/60">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
              <tr>
                {section.columns.map((col, i) => (
                  <th
                    key={`${col}-${i}`}
                    className={cn(
                      'px-2 py-1 text-left font-medium',
                      i === section.columns.length - 1 && 'text-right'
                    )}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, rowIdx) => (
                <tr
                  key={`${row.cells.join('|')}-${rowIdx}`}
                  className="border-t border-border/40"
                >
                  {row.cells.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      className={cn(
                        'px-2 py-1 align-top',
                        cellIdx === row.cells.length - 1 &&
                          'text-right tabular-nums',
                        cellIdx < row.cells.length - 1 &&
                          'text-foreground/90 break-all'
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
