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
  className?: string
}

export function StatusIndicator({
  status,
  variant = 'default',
  shape = 'circle',
  className,
}: StatusIndicatorProps) {
  const shapeClass = shape === 'square' ? 'rounded-sm' : 'rounded-full'

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
      className={cn(
        'shrink-0 block bg-current',
        shape === 'circle' ? 'rounded-full' : 'rounded-sm',
        colorClass,
        className
      )}
    />
  )
}
