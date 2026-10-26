import React, { useState } from 'react'
import { ChevronRight } from '@/components/icons/reicon'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { BackendLabel } from '@/components/ui/backend-label'
import type { CliBackend } from '@/types/preferences'
import { cn } from '@/lib/utils'

export interface SettingsSectionProps {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  anchorId?: string
  variant?: 'default' | 'card'
  /** Optional sections stay collapsed until the user opens them. */
  collapsible?: boolean
  defaultOpen?: boolean
  children: React.ReactNode
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  actions,
  anchorId,
  variant = 'card',
  collapsible = false,
  defaultOpen = true,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const titleClass = cn(
    'font-medium text-foreground',
    variant === 'card' ? 'text-base' : 'text-lg'
  )
  const header = (
    <div className={variant === 'card' ? 'px-1 sm:px-2' : undefined}>
      <div className="flex flex-wrap items-center gap-3">
        {collapsible ? (
          <h3 className={titleClass}>
            <CollapsibleTrigger className="inline-flex items-center gap-1.5 text-left">
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-90'
                )}
              />
              {title}
            </CollapsibleTrigger>
          </h3>
        ) : (
          <h3 className={titleClass}>{title}</h3>
        )}
        {actions && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-2',
              variant === 'card' && 'ml-auto'
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {variant === 'default' && <Separator className="mt-2" />}
    </div>
  )
  const body = (
    <div
      className={cn(
        'space-y-4',
        variant === 'card' &&
          'min-w-0 rounded-xl border border-border bg-muted/30 p-4 sm:p-5 sm:[&_.settings-inline-field]:flex-wrap sm:[&_.settings-inline-field]:justify-between sm:[&_.settings-inline-field>div:first-child]:w-auto [&_.settings-inline-field>div:first-child]:min-w-32 [&_.settings-inline-field>div:first-child]:flex-1 [&_.settings-inline-field>div:first-child]:break-words'
      )}
    >
      {children}
    </div>
  )

  if (!collapsible) {
    return (
      <div id={anchorId} className="min-w-0 space-y-3">
        {header}
        {body}
      </div>
    )
  }

  return (
    <Collapsible
      id={anchorId}
      open={open}
      onOpenChange={setOpen}
      className="min-w-0 space-y-3"
    >
      {header}
      <CollapsibleContent>{body}</CollapsibleContent>
    </Collapsible>
  )
}

export const BackendPaneHeader: React.FC<{
  backend: CliBackend
  description?: React.ReactNode
}> = ({ backend, description }) => (
  <div>
    <h2 className="flex items-center gap-2 text-lg font-semibold">
      <BackendLabel backend={backend} />
    </h2>
    {description && (
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    )}
  </div>
)
