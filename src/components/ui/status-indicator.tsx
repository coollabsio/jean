import { cn } from '@/lib/utils'

export type IndicatorStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'review'
  | 'completed'
export type IndicatorVariant = 'default' | 'destructive' | 'loading'
export type IndicatorShape = 'circle' | 'square'

interface StatusIndicatorProps {
  status: IndicatorStatus
  variant?: IndicatorVariant
  shape?: IndicatorShape
  title?: string
  className?: string
}

function getDefaultTitle(status: IndicatorStatus, variant: IndicatorVariant): string {
  if (status === 'running') {
    if (variant === 'destructive') return 'Running (yolo mode)'
    if (variant === 'loading') return 'Loading'
    return 'Running'
  }
  if (status === 'waiting') return 'Waiting for input'
  if (status === 'review') return 'Ready for review'
  if (status === 'completed') return 'Completed'
  return 'Idle'
}

export function StatusIndicator({
  status,
  variant = 'default',
  shape = 'circle',
  title,
  className,
}: StatusIndicatorProps) {
  const shapeClass = shape === 'square' ? 'rounded-sm' : 'rounded-full'
  const resolvedTitle = title ?? getDefaultTitle(status, variant)

  // Running state: CSS border spinner
  if (status === 'running') {
    const colorClass =
      variant === 'destructive'
        ? 'border-t-destructive bg-destructive/10 '
        : variant === 'loading'
          ? 'border-t-cyan-500 bg-cyan-500/10 '
          : 'border-t-yellow-500 bg-yellow-500/10'

    return (
      <span
        title={resolvedTitle}
        className={cn(
          'shrink-0 block animate-spin border-2 border-transparent',
          shapeClass,
          colorClass,
          className
        )}
      />
    )
  }

  // Static states: use simple filled shapes
  const colorClass =
    status === 'waiting'
      ? 'text-yellow-500 animate-blink '
      : status === 'review' || status === 'completed'
        ? 'text-green-500'
        : 'text-muted-foreground/50'

  return (
    <span
      title={resolvedTitle}
      className={cn(
        'shrink-0 block bg-current',
        shape === 'circle' ? 'rounded-full' : 'rounded-sm',
        colorClass,
        className
      )}
    />
  )
}
