import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface ApprovalCardProps {
  title?: ReactNode
  /** Optional muted text below the title (e.g. the agent's reason). */
  description?: ReactNode
  /** Action buttons, rendered in a row below the body. */
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

/**
 * Shared shell for approval / input request cards (every backend, questions,
 * agent chat), so every prompt looks the same in chat. Sans font for the
 * chrome; callers use font-mono only for command or code content.
 */
export function ApprovalCard({
  title,
  description,
  actions,
  children,
  className,
}: ApprovalCardProps) {
  return (
    <div
      className={cn(
        'my-3 rounded-lg border border-border bg-muted/30 p-4 text-sm',
        className
      )}
    >
      {title ? <div className="mb-2 font-medium">{title}</div> : null}
      {description ? (
        <div className="mb-3 text-muted-foreground">{description}</div>
      ) : null}
      {children}
      {actions ? (
        <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
