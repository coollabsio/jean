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

export type IndicatorVariant = 'default' | 'destructive' | 'loading'
export type IndicatorShape = 'circle' | 'square' | 'diamond' | 'ring'

interface StatusIndicatorProps {
  status: IndicatorStatus
  variant?: IndicatorVariant
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

export function StatusIndicator({
  status,
  variant = 'default',
  shape,
  label,
  className,
}: StatusIndicatorProps) {
  const resolvedShape = resolveShape(status, shape)
  const shapeClass = shapeClasses(resolvedShape)
  const title = label

  // Running state: CSS border spinner (shape still communicates meaning without color)
  if (status === 'running') {
    const colorClass =
      variant === 'destructive'
        ? 'border-t-destructive bg-destructive/10 forced-colors:border-t-[Highlight]'
        : variant === 'loading'
          ? 'border-t-cyan-500 bg-cyan-500/10 forced-colors:border-t-[Highlight]'
          : 'border-t-yellow-500 bg-yellow-500/10 forced-colors:border-t-[Highlight]'

    return (
      <span
        role="img"
        aria-label={label}
        title={title}
        className={cn(
          'shrink-0 block animate-spin border-2 border-transparent motion-reduce:animate-none',
          // Reduced motion: solid fill instead of spinner so status remains visible
          'motion-reduce:border-0 motion-reduce:bg-current',
          variant === 'destructive'
            ? 'motion-reduce:text-destructive'
            : variant === 'loading'
              ? 'motion-reduce:text-cyan-500'
              : 'motion-reduce:text-yellow-500',
          shapeClass,
          colorClass,
          className
        )}
      />
    )
  }

  // Static states: filled/outline shapes with distinct colors + shapes
  const colorClass =
    status === 'waiting' ||
    status === 'plan_approval' ||
    status === 'input_required' ||
    status === 'permission'
      ? 'text-yellow-500 animate-blink motion-reduce:animate-none forced-colors:text-[Highlight]'
      : status === 'review' || status === 'completed'
        ? 'text-green-500 forced-colors:text-[Highlight]'
        : status === 'crashed'
          ? 'text-destructive forced-colors:text-[Mark]'
          : status === 'scheduled'
            ? 'text-cyan-500 forced-colors:text-[Highlight]'
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
      className={cn(
        'shrink-0 block',
        fillClass,
        shapeClass,
        colorClass,
        className
      )}
    />
  )
}
