import type { ReactNode } from 'react'
import { Columns2, Rows3, type LucideIcon } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface Segment<T extends string> {
  value: T
  label: string
  icon: LucideIcon
  tooltip?: string
  /** Extra content after the label (counts, key hints). */
  trailing?: ReactNode
}

/** Pill-style single-choice switcher. Labels collapse to icons below `sm`. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  segments,
  className,
}: {
  value: T
  onChange: (value: T) => void
  segments: readonly Segment<T>[]
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center rounded-lg bg-muted p-1',
        className
      )}
    >
      {segments.map(segment => {
        const Icon = segment.icon
        const button = (
          <button
            key={segment.value}
            type="button"
            aria-pressed={value === segment.value}
            aria-label={segment.label}
            onClick={() => onChange(segment.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors sm:flex-none sm:shrink-0 sm:px-3',
              value === segment.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">{segment.label}</span>
            {segment.trailing}
          </button>
        )
        if (!segment.tooltip) return button
        return (
          <Tooltip key={segment.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{segment.tooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

export type DiffStyle = 'split' | 'unified'

const DIFF_STYLE_SEGMENTS: readonly Segment<DiffStyle>[] = [
  {
    value: 'split',
    label: 'Split',
    icon: Columns2,
    tooltip: 'Side-by-side view',
  },
  { value: 'unified', label: 'Stacked', icon: Rows3, tooltip: 'Unified view' },
]

/** Split/Stacked switch shared by the diff modals. */
export function DiffStyleToggle({
  value,
  onChange,
  className,
}: {
  value: DiffStyle
  onChange: (value: DiffStyle) => void
  className?: string
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      segments={DIFF_STYLE_SEGMENTS}
      className={className}
    />
  )
}
