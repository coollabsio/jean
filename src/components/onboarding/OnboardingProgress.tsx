import { cn } from '@/lib/utils'

interface OnboardingProgressProps {
  labels: readonly string[]
  /** Index of the active segment. */
  current: number
}

/** Thin segmented bar with labels at the top of the onboarding dialog. */
export function OnboardingProgress({
  labels,
  current,
}: OnboardingProgressProps) {
  return (
    <ol
      className="grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))`,
      }}
    >
      {labels.map((label, index) => {
        const state =
          index < current ? 'done' : index === current ? 'active' : 'pending'
        return (
          <li
            key={label}
            aria-current={state === 'active' ? 'step' : undefined}
            className="space-y-1.5"
          >
            <div
              className={cn(
                'h-1 rounded-full transition-colors duration-300 motion-reduce:transition-none',
                state === 'active' && 'bg-primary',
                state === 'done' && 'bg-primary/60',
                state === 'pending' && 'bg-muted'
              )}
            />
            <span
              className={cn(
                'block text-[11px]',
                state === 'pending'
                  ? 'text-muted-foreground/70'
                  : 'text-muted-foreground',
                state === 'active' && 'font-medium text-foreground'
              )}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
