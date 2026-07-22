import { Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TerminalActivityIconProps {
  active: boolean
  className?: string
}

/** Terminal glyph with a live-PTY badge for compact session controls. */
export function TerminalActivityIcon({
  active,
  className,
}: TerminalActivityIconProps) {
  return (
    <span className="relative inline-flex shrink-0" aria-hidden="true">
      <Terminal className={className} />
      {active && (
        <span
          data-testid="terminal-active-badge"
          className={cn(
            'absolute -right-0.5 -top-0.5 size-1.5 rounded-full',
            'bg-emerald-500 ring-1 ring-background'
          )}
        />
      )}
    </span>
  )
}
