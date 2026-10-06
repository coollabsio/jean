import type { ReactNode } from 'react'

interface ApprovalCardProps {
  title: ReactNode
  /** Optional muted text below the title (e.g. the agent's reason). */
  description?: ReactNode
  /** Action buttons, rendered in a row below the body. */
  actions: ReactNode
  children?: ReactNode
}

/**
 * Shared shell for approval / input request cards (Claude, Codex, OpenCode),
 * so every backend's prompt looks the same in chat.
 */
export function ApprovalCard({
  title,
  description,
  actions,
  children,
}: ApprovalCardProps) {
  return (
    <div className="my-3 rounded border border-muted bg-muted/30 p-4 font-mono text-sm">
      <div className="mb-2 font-semibold">{title}</div>
      {description ? (
        <div className="mb-3 text-muted-foreground">{description}</div>
      ) : null}
      {children}
      <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
    </div>
  )
}
