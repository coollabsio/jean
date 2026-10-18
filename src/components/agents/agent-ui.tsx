import type { ReactNode } from 'react'
import { Info } from '@/components/icons/reicon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Scrolling body of an agent tab with one readable column. */
export function AgentTabBody({
  children,
  className,
  wide = false,
}: {
  children: ReactNode
  className?: string
  /** List-heavy tabs use more width than forms */
  wide?: boolean
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          'mx-auto flex w-full flex-col gap-8 px-4 py-5 sm:px-6',
          wide ? 'max-w-4xl' : 'max-w-2xl',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** Info icon that shows help text on hover or focus instead of a paragraph. */
export function HelpTip({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-balance">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

/** Section heading with an optional count, help tooltip, and actions. */
export function AgentSection({
  title,
  count,
  description,
  actions,
  children,
  className,
  testId,
}: {
  title: ReactNode
  count?: number
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <section
      className={cn('flex flex-col gap-3', className)}
      data-testid={testId}
    >
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {count !== undefined && (
            <Badge variant="muted" className="px-1.5 py-0 tabular-nums">
              {count}
            </Badge>
          )}
          {description && (
            <HelpTip
              label={`About ${typeof title === 'string' ? title : 'this section'}`}
            >
              {description}
            </HelpTip>
          )}
        </h3>
        {actions && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>
      {children}
    </section>
  )
}

/** Bordered list with dividers; rows are `<li>` elements. */
export function AgentList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <ul
      className={cn(
        'divide-y divide-border/60 overflow-hidden rounded-lg border',
        className
      )}
    >
      {children}
    </ul>
  )
}

/** One-line placeholder for an empty list. */
export function AgentEmpty({
  title,
  action,
}: {
  title: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-4 text-center text-sm text-muted-foreground">
      <span>{title}</span>
      {action}
    </div>
  )
}

export function AgentLoading({ label }: { label: string }) {
  return <p className="py-2 text-xs text-muted-foreground">{label}</p>
}

/** Amber banner for states that block the agent (stopped, hourly limit). */
export function AgentNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      {children}
    </p>
  )
}

/** Inline form panel (composer, editor). */
export function AgentPanel({
  children,
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-lg border p-4', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export type AgentTone = 'neutral' | 'active' | 'attention' | 'danger'

const TONE_CLASSES: Record<AgentTone, string> = {
  neutral: 'bg-muted/60 text-muted-foreground',
  active: 'bg-primary/15 text-primary',
  attention: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  danger: 'bg-destructive/15 text-destructive',
}

/** Small status or tag pill used in agent list rows. */
export function AgentBadge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: AgentTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none [&>svg]:size-3',
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/** Tone for task, delegation, and approval statuses. */
export function statusTone(status: string): AgentTone {
  switch (status) {
    case 'running':
    case 'active':
      return 'active'
    case 'waiting':
    case 'pending':
      return 'attention'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** Save / discard row at the bottom of a settings panel. */
export function SaveFooter({
  dirty,
  pending,
  label = 'Save',
  onDiscard,
  onSave,
}: {
  dirty: boolean
  pending: boolean
  label?: string
  onDiscard: () => void
  onSave: () => void
}) {
  return (
    <div className="-mx-4 -mb-4 mt-1 flex items-center justify-end gap-2 border-t bg-muted/20 px-4 py-2.5">
      {dirty && (
        <span className="mr-auto text-xs text-muted-foreground">
          Unsaved changes
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!dirty || pending}
        onClick={onDiscard}
      >
        Discard
      </Button>
      <Button size="sm" disabled={!dirty || pending} onClick={onSave}>
        {label}
      </Button>
    </div>
  )
}
