import { Loader2 } from '@/components/icons/reicon'
import { cn } from '@/lib/utils'
import type { Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'

interface WorktreeItemSkeletonProps {
  worktree: Worktree
}

/**
 * Skeleton placeholder for a worktree that is being created or deleted in the background.
 * Shows a pulsing animation and the worktree name while the operation is in progress.
 */
export function WorktreeItemSkeleton({ worktree }: WorktreeItemSkeletonProps) {
  const isSelected = useProjectsStore(
    state => state.selectedWorktreeId === worktree.id
  )
  const isDeleting = worktree.status === 'deleting'

  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 py-1.5 pl-10 pr-2',
        isSelected && 'bg-accent/50',
        // Pulsing animation for the entire row
        'animate-pulse'
      )}
    >
      {/* Spinner icon */}
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />

      {/* Worktree name with reduced opacity */}
      <span className="flex-1 truncate text-sm text-muted-foreground">
        {worktree.name}
      </span>

      {/* Status indicator */}
      <span className="shrink-0 text-xs text-muted-foreground">
        {isDeleting ? 'Deleting...' : 'Creating...'}
      </span>
    </div>
  )
}
