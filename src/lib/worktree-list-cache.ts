import type { Worktree } from '@/types/projects'

/**
 * Merge a server `list_worktrees` response with client-only optimistic entries.
 *
 * Pending worktrees are not persisted until git creation finishes, so any
 * refetch that replaces the query cache would otherwise remove them from the
 * sidebar while the "Setting up worktree..." toast is still visible (#528).
 *
 * Server-backed rows remain authoritative so a missed optimistic-state event
 * cannot leave them stuck in a transient status.
 */
export function mergeWorktreesPreservingOptimistic(
  serverWorktrees: Worktree[],
  previous: Worktree[] | undefined
): Worktree[] {
  if (!previous?.length) return serverWorktrees

  const serverIds = new Set(serverWorktrees.map(w => w.id))

  const pendingOnly = previous.filter(
    w => w.status === 'pending' && !serverIds.has(w.id)
  )

  if (pendingOnly.length === 0) return serverWorktrees

  // Keep creating rows visible (sidebar/canvas show pending first).
  return [...pendingOnly, ...serverWorktrees]
}

export function removePendingWorktree(
  worktrees: Worktree[] | undefined,
  worktreeId: string
): Worktree[] {
  return (worktrees ?? []).filter(
    worktree => worktree.id !== worktreeId || worktree.status !== 'pending'
  )
}
