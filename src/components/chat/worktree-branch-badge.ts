export function getStackedBaseBranch(
  baseBranch: string | undefined,
  worktreeBranch: string | undefined,
  defaultBranch: string | undefined
): string | null {
  if (
    !baseBranch ||
    baseBranch === defaultBranch ||
    baseBranch === worktreeBranch
  ) {
    return null
  }

  return baseBranch
}

interface WorktreeBranchBadgeContext {
  displayBranch: string | undefined
  worktreeName: string
  stackedBaseBranch: string | null
  prNumber?: number
  securityAlertNumber?: number
  advisoryGhsaId?: string
}

export function shouldShowWorktreeBranchBadge({
  displayBranch,
  worktreeName,
  stackedBaseBranch,
  prNumber,
  securityAlertNumber,
  advisoryGhsaId,
}: WorktreeBranchBadgeContext): boolean {
  return Boolean(
    displayBranch &&
    (displayBranch !== worktreeName ||
      stackedBaseBranch ||
      prNumber ||
      securityAlertNumber ||
      advisoryGhsaId)
  )
}
