import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

function StatusTooltip({
  label,
  children,
}: {
  label?: string
  children: ReactElement
}) {
  if (!label) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export type IndicatorStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'plan_approval'
  | 'input_required'
  | 'permission'
  | 'review'
  | 'completed'
  | 'cancelled'
  | 'crashed'
  | 'scheduled'

export type IndicatorShape = 'circle' | 'square' | 'diamond' | 'ring'

interface StatusIndicatorProps {
  status: IndicatorStatus
  shape?: IndicatorShape
  /** Accessible name describing the status. Shown in the shared tooltip. */
  label?: string
  className?: string
}

function resolveShape(
  status: IndicatorStatus,
  shape?: IndicatorShape
): IndicatorShape {
  if (shape) return shape
  switch (status) {
    case 'plan_approval':
      return 'square'
    case 'input_required':
      return 'diamond'
    case 'permission':
      return 'square'
    case 'cancelled':
      return 'ring'
    case 'crashed':
      return 'square'
    case 'scheduled':
      return 'diamond'
    case 'waiting':
      return 'diamond'
    default:
      return 'circle'
  }
}

function shapeClasses(shape: IndicatorShape): string {
  switch (shape) {
    case 'square':
      return 'rounded-sm'
    case 'diamond':
      return 'rounded-sm rotate-45'
    case 'ring':
      return 'rounded-full border-2 border-current bg-transparent'
    case 'circle':
    default:
      return 'rounded-full'
  }
}

/** Small 3-bar activity waveform shown for running sessions/agents. */
export function WorkingWaveform({
  label,
  className,
}: {
  label?: string
  className?: string
}) {
  return (
    <StatusTooltip label={label}>
      <span
        {...(label
          ? { role: 'img' as const, 'aria-label': label }
          : { 'aria-hidden': true as const })}
        className={cn(
          'working-waveform shrink-0 text-primary forced-colors:text-[Highlight]',
          className
        )}
      >
        <span />
        <span />
        <span />
      </span>
    </StatusTooltip>
  )
}

export function StatusIndicator({
  status,
  shape,
  label,
  className,
}: StatusIndicatorProps) {
  const resolvedShape = resolveShape(status, shape)
  const shapeClass = shapeClasses(resolvedShape)

  // Running state: shared 3-bar waveform. It has a fixed size, so the
  // dot size classes from `className` do not apply here. Static dots sit in
  // a slot of the same size so layouts do not shift between states.
  if (status === 'running') {
    return <WorkingWaveform label={label} />
  }

  // Static states: filled/outline shapes with distinct colors + shapes
  const colorClass =
    status === 'waiting' ||
    status === 'plan_approval' ||
    status === 'input_required' ||
    status === 'permission'
      ? 'text-warning animate-blink motion-reduce:animate-none forced-colors:text-[Highlight]'
      : status === 'review' || status === 'completed'
        ? 'text-success forced-colors:text-[Highlight]'
        : status === 'crashed'
          ? 'text-destructive forced-colors:text-[Mark]'
          : status === 'scheduled'
            ? 'text-info forced-colors:text-[Highlight]'
            : status === 'cancelled'
              ? 'text-muted-foreground forced-colors:text-[GrayText]'
              : 'text-muted-foreground/50 forced-colors:text-[GrayText]'

  // Ring shape already uses border + transparent fill; others fill with currentColor
  const fillClass = resolvedShape === 'ring' ? '' : 'bg-current'

  return (
    <StatusTooltip label={label}>
      <span
        role="img"
        aria-label={label}
        className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      >
        <span
          className={cn(
            'shrink-0 block',
            fillClass,
            shapeClass,
            colorClass,
            className
          )}
        />
      </span>
    </StatusTooltip>
  )
}
