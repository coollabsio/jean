import type { Worktree } from '@/types/projects'

export function resolveModalWorktreeSnapshot(
  selectedWorktreeId: string | null,
  worktrees: Worktree[],
  previous: Worktree | null
): Worktree | null {
  if (!selectedWorktreeId) return null

  return (
    worktrees.find(worktree => worktree.id === selectedWorktreeId) ??
    (previous?.id === selectedWorktreeId ? previous : null)
  )
}
