import { forwardRef } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Worktree } from '@/types/projects'

export interface WorktreeSetupCardProps {
  worktree: Worktree
  isSelected?: boolean
  onSelect?: () => void
  layout?: 'list'
}

function getStatusText(worktree: Worktree): string {
  if (worktree.pr_number) return `Checking out PR #${worktree.pr_number}...`
  if (worktree.issue_number) return 'Setting up branch...'
  if (worktree.security_alert_number)
    return `Fixing alert #${worktree.security_alert_number}...`
  if (worktree.advisory_ghsa_id) return `Fixing ${worktree.advisory_ghsa_id}...`
  return 'Creating worktree...'
}

/**
 * Card shown in canvas views while a worktree is being set up (jean.json setup script running).
 */
export const WorktreeSetupCard = forwardRef<
  HTMLDivElement,
  WorktreeSetupCardProps
>(function WorktreeSetupCard({ worktree, isSelected, onSelect }, ref) {
  const statusText = getStatusText(worktree)

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-3 rounded-md px-3 py-1.5 border border-transparent transition-colors text-left cursor-pointer scroll-mt-28 scroll-mb-20',
        'animate-pulse hover:bg-muted/50 hover:border-foreground/10',
        isSelected &&
          'border-primary/50 bg-primary/5 hover:border-primary/50 hover:bg-primary/10'
      )}
    >
      {/* Spinner */}
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />

      {/* Worktree name */}
      <span className="flex-1 truncate text-sm text-muted-foreground">
        {worktree.name}
      </span>

      {/* Status text */}
      <span className="text-xs text-muted-foreground shrink-0">
        {statusText}
      </span>
    </div>
  )
})
