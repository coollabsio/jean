import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/ui/help-tip'
import { cn } from '@/lib/utils'

/**
 * One settings row. `inline` puts the label column beside the control on
 * wider screens; `stacked` puts the control under the label.
 */
export function InlineField({
  id,
  label,
  description,
  help,
  layout = 'inline',
  htmlFor,
  className,
  children,
}: {
  id?: string
  label: ReactNode
  /** One short muted line under the label. */
  description?: ReactNode
  /** Longer explanation, shown in a tooltip next to the label. */
  help?: ReactNode
  layout?: 'inline' | 'stacked'
  htmlFor?: string
  className?: string
  children?: ReactNode
}) {
  const inline = layout === 'inline'
  return (
    <div
      id={id}
      className={cn(
        inline
          ? 'flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4'
          : 'space-y-2',
        className
      )}
    >
      <div
        className={cn(
          'min-w-0 space-y-0.5',
          inline && 'sm:w-56 sm:shrink-0 lg:w-72'
        )}
      >
        <div className="flex items-center gap-1.5">
          <Label htmlFor={htmlFor} className="text-sm font-normal text-foreground">
            {label}
          </Label>
          {help && (
            <HelpTip
              label={`About ${typeof label === 'string' ? label : 'this setting'}`}
            >
              {help}
            </HelpTip>
          )}
        </div>
        {description && (
          <div className="text-xs break-words text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
