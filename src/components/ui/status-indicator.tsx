import { cn } from '@/lib/utils'

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
  /** Accessible name describing the status (also used as title fallback). */
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
    <span
      {...(label
        ? { role: 'img', 'aria-label': label, title: label }
        : { 'aria-hidden': true })}
      className={cn(
        'working-waveform shrink-0 text-primary forced-colors:text-[Highlight]',
        className
      )}
    >
      <span />
      <span />
      <span />
    </span>
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
  const title = label

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
    <span
      role="img"
      aria-label={label}
      title={title}
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
  )
}
