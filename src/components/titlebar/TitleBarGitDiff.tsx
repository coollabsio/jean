import { GitStatusBadges } from '@/components/ui/git-status-badges'
import { useGitStatus } from '@/services/git-status'
import { useWorktree } from '@/services/projects'
import { isBaseSession } from '@/types/projects'

const openDiff = (type: 'uncommitted' | 'branch') => () =>
  window.dispatchEvent(new CustomEvent('open-git-diff', { detail: { type } }))

/** Mobile title bar: diff counts of the worktree open in the session modal. */
export function TitleBarGitDiff({ worktreeId }: { worktreeId: string }) {
  const { data: worktree } = useWorktree(worktreeId)
  const { data: gitStatus } = useGitStatus(worktreeId)
  const isBase = worktree ? isBaseSession(worktree) : false

  return (
    <GitStatusBadges
      behindCount={0}
      unpushedCount={0}
      diffAdded={
        gitStatus?.uncommitted_added ?? worktree?.cached_uncommitted_added ?? 0
      }
      diffRemoved={
        gitStatus?.uncommitted_removed ??
        worktree?.cached_uncommitted_removed ??
        0
      }
      branchDiffAdded={
        isBase
          ? 0
          : (gitStatus?.branch_diff_added ??
            worktree?.cached_branch_diff_added ??
            0)
      }
      branchDiffRemoved={
        isBase
          ? 0
          : (gitStatus?.branch_diff_removed ??
            worktree?.cached_branch_diff_removed ??
            0)
      }
      onDiffClick={openDiff('uncommitted')}
      onBranchDiffClick={openDiff('branch')}
    />
  )
}
