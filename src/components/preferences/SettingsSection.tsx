import React, { useState } from 'react'
import { ChevronRight } from '@/components/icons/reicon'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export interface SettingsSectionProps {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  anchorId?: string
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
  collapsible = false,
  defaultOpen = true,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const header = (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {collapsible ? (
            <CollapsibleTrigger className="inline-flex items-center gap-1.5 text-left">
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-90'
                )}
              />
              {title}
            </CollapsibleTrigger>
          ) : (
            title
          )}
        </h3>
        {actions && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  )
  const body = <div className="min-w-0 space-y-4">{children}</div>

  if (!collapsible) {
    return (
      <section id={anchorId} className="min-w-0 space-y-4 not-first:border-t not-first:border-border/60 not-first:pt-6">
        {header}
        {body}
      </section>
    )
  }

  return (
    <Collapsible
      id={anchorId}
      open={open}
      onOpenChange={setOpen}
      className="min-w-0 space-y-4 not-first:border-t not-first:border-border/60 not-first:pt-6"
    >
      {header}
      {/* Mounted while closed so Settings search can find and open it. */}
      <CollapsibleContent forceMount hidden={!open}>
        {body}
      </CollapsibleContent>
    </Collapsible>
  )
}
