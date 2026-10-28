import type { ReactNode } from 'react'
import { Plus, X } from '@/components/icons/reicon'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import type { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { VariantProps } from 'class-variance-authority'

/** Look of one list row in an agent tab (unbordered, hover tint). */
export const AGENT_ROW =
  'rounded-md px-2 py-1.5 transition-colors hover:bg-muted/30'

/** Scrolling body of an agent tab. */
export function AgentTabBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('flex w-full flex-col gap-4 p-3', className)}>
        {children}
      </div>
    </div>
  )
}

/** Small muted section title; `description` shows as its tooltip. */
function SectionTitle({
  title,
  count,
  description,
}: {
  title: ReactNode
  count?: number
  description?: ReactNode
}) {
  const label = (
    <span
      className={cn(description && 'cursor-help')}
      tabIndex={description ? 0 : undefined}
    >
      {title}
    </span>
  )
  return (
    <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {description ? (
        <Tooltip>
          <TooltipTrigger asChild>{label}</TooltipTrigger>
          <TooltipContent className="max-w-72 text-balance">
            {description}
          </TooltipContent>
        </Tooltip>
      ) : (
        label
      )}
      {count !== undefined && (
        <span className="font-normal tabular-nums text-muted-foreground/70">
          {count}
        </span>
      )}
    </h3>
  )
}

/**
 * Section with a small title, plain count, and actions. Omit the title when
 * the section is the whole tab, so it does not repeat the tab name.
 */
export function AgentSection({
  title,
  count,
  description,
  actions,
  children,
  className,
  testId,
}: {
  title?: ReactNode
  count?: number
  /** Tooltip on the title */
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <section
      className={cn('flex flex-col gap-1.5', className)}
      data-testid={testId}
    >
      {(title || actions) && (
        <div className="flex min-h-6 items-center justify-between gap-2 px-2">
          {title ? (
            <SectionTitle
              title={title}
              count={count}
              description={description}
            />
          ) : (
            <span />
          )}
          {actions && (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          )}
        </div>
      )}
      {children}
    </section>
  )
}

/** Plain list; rows are `<li>` elements styled with `AGENT_ROW`. */
export function AgentList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <ul className={cn('flex flex-col', className)}>{children}</ul>
}

/** One muted line for an empty list. */
export function AgentEmpty({
  title,
  action,
}: {
  title: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
      <p>{title}</p>
      {action}
    </div>
  )
}

export function AgentLoading({ label }: { label: string }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{label}</p>
}

/** Warning line for states that block the agent (stopped, hourly limit). */
export function AgentNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-warning/5 px-2 py-1.5 text-xs text-warning">
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
      className={cn(
        'flex flex-col gap-3 rounded-md border border-border/50 p-3',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/** Row of agent faces to pick a color. `jean` shows as "default". */
export function AgentColorPicker({
  value,
  choices,
  disabled,
  onChange,
}: {
  value: string
  choices: readonly string[]
  disabled?: boolean
  onChange: (color: string) => void
}) {
  return (
    <div className="flex gap-2" role="radiogroup" aria-label="Color">
      {choices.map(color => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color === 'jean' ? 'default' : color}
          disabled={disabled}
          className={cn(
            'rounded-md p-1 transition-colors disabled:opacity-50',
            value === color
              ? 'bg-primary/15 ring-1 ring-primary'
              : 'hover:bg-muted'
          )}
          onClick={() => onChange(color)}
        >
          <AgentIcon icon={color} className="size-6" />
        </button>
      ))}
    </div>
  )
}

/** Ghost icon button that opens (or closes) an inline composer. */
export function AgentAddButton({
  open,
  label,
  onClick,
}: {
  open: boolean
  label: string
  onClick: () => void
}) {
  const text = open ? 'Close' : label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={text}
          aria-expanded={open}
          className="text-muted-foreground"
          onClick={onClick}
        >
          {open ? <X /> : <Plus />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

/** Badge variant for task, delegation, and approval statuses. */
export function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'running':
    case 'active':
      return 'info'
    case 'waiting':
    case 'pending':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'subtle'
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
    <div className="flex items-center justify-end gap-2">
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
