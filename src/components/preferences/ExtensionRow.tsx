import React, { useState } from 'react'
import { ChevronRight, ExternalLink } from '@/components/icons/reicon'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { openExternal } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** Titled group of extension rows (plugins, MCP servers). */
export function ExtensionGroup({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-1">
      <div className="flex items-center gap-2 px-2">
        <h4
          id={id}
          className="shrink-0 text-xs font-medium text-muted-foreground"
        >
          {title}
        </h4>
        <Separator className="flex-1" />
      </div>
      <div>{children}</div>
    </section>
  )
}

interface ExtensionRowProps {
  name: string
  /** Status badge next to the name. */
  status?: React.ReactNode
  /** Small icon button kept on the name line (for example, refresh). */
  iconAction?: React.ReactNode
  /** Buttons on the right side of the row. */
  actions?: React.ReactNode
  anchorId?: string
  /** Details shown when the row is expanded. */
  children: React.ReactNode
}

/** Expandable row: chevron, name, status badge, and actions. */
export function ExtensionRow({
  name,
  status,
  iconAction,
  actions,
  anchorId,
  children,
}: ExtensionRowProps) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible id={anchorId} open={open} onOpenChange={setOpen}>
      <div className="flex min-h-10 min-w-0 max-w-full flex-col gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <CollapsibleTrigger className="flex min-w-0 w-full flex-1 items-center gap-2 overflow-hidden text-left">
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-90'
              )}
            />
            <span className="max-w-[46%] shrink-0 overflow-hidden text-sm font-medium text-foreground sm:w-36 sm:max-w-none">
              <span className="block truncate">{name}</span>
            </span>
            <span className="flex min-w-0 flex-1 items-center overflow-hidden">
              {status}
            </span>
          </CollapsibleTrigger>
          {iconAction && (
            <span className="flex shrink-0 items-center">{iconAction}</span>
          )}
        </div>
        {actions && (
          <span className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0 sm:flex-nowrap">
            {actions}
          </span>
        )}
      </div>
      <CollapsibleContent className="space-y-3 pb-3 pl-7 pr-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Small "How to use"-style block inside an expanded row. */
export function ExtensionDetail({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="text-xs font-medium text-foreground/80">{title}</div>
      {children}
    </div>
  )
}

export function ExtensionLink({ url, label }: { url: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </button>
  )
}
