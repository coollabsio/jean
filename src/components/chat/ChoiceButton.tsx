import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

interface ChoiceButtonProps {
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: string
  /** Keyboard hint shown on the right; omit to hide it */
  shortcut?: string
  disabled?: boolean
  onClick: () => void
}

/** Full-width option row used by choice modals (new session, review) */
export function ChoiceButton({
  icon,
  title,
  subtitle,
  badge,
  shortcut,
  disabled,
  onClick,
}: ChoiceButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors',
        'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium leading-none">
          {title}
          {badge && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {shortcut && <Kbd className="shrink-0 text-2xs">{shortcut}</Kbd>}
    </button>
  )
}
