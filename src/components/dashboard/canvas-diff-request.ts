import type { DiffRequest } from '@/types/git-diff'
import type { Worktree } from '@/types/projects'

export function getCanvasDiffRequest(
  worktree: Worktree,
  defaultBranch: string,
  type: DiffRequest['type']
): DiffRequest {
  return {
    type,
    worktreePath: worktree.path,
    baseBranch: worktree.base_branch ?? defaultBranch,
    baseRemote: worktree.base_remote,
  }
}
