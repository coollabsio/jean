import { memo } from 'react'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { ProviderChange } from './message-settings-labels'

interface ProviderChangeSeparatorProps {
  change: ProviderChange
  className?: string
}

/**
 * Horizontal rule between chat prompts when the user switches backend/provider.
 */
export const ProviderChangeSeparator = memo(function ProviderChangeSeparator({
  change,
  className,
}: ProviderChangeSeparatorProps) {
  const label = `${change.fromLabel} → ${change.toLabel}`

  return (
    <div
      role="separator"
      aria-label={`Provider changed from ${change.fromLabel} to ${change.toLabel}`}
      data-testid="provider-change-separator"
      data-from-provider={change.from}
      data-to-provider={change.to}
      className={cn(
        'relative my-3 flex items-center justify-center py-1',
        className
      )}
    >
      <Separator className="absolute inset-x-0 top-1/2" />
      <span className="bg-background text-muted-foreground relative px-3 text-[11px] font-medium tracking-wide">
        {label}
      </span>
    </div>
  )
})
