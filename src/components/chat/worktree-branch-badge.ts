export function getStackedBaseBranch(
  baseBranch: string | undefined,
  worktreeBranch: string | undefined,
  defaultBranch: string | undefined,
  baseRemote?: string
): string | null {
  if (!baseBranch) return null

  // A base picked from an explicit remote is always worth showing: on a project
  // with several remotes, "main" alone doesn't say which repository it came from.
  if (baseRemote) return `${baseRemote}/${baseBranch}`

  if (baseBranch === defaultBranch || baseBranch === worktreeBranch) {
    return null
  }

  return baseBranch
}

export interface StackedPrCandidate {
  number: number
  headRefName: string
  /** PR target branch when available (used to detect long-lived base branches). */
  baseRefName?: string
  /** Optional display title when the candidate comes from a full PR listing. */
  title?: string
}

/**
 * Decide whether a worktree whose base is `stackedBaseBranch` is intentionally
 * stacked on an open PR, vs. merely using a long-lived branch (e.g. `v4.x`) as
 * its git start point.
 *
 * Matching only on `headRefName === base` is wrong for release/maintenance
 * branches: any open PR whose head is that branch (often a fork PR) would
 * incorrectly appear as "stacked on #N" for every new worktree based there.
 */
export function resolveStackedOnPr(
  stackedBaseBranch: string | null,
  openPRs: StackedPrCandidate[] | undefined,
  defaultBranch?: string
): StackedPrCandidate | undefined {
  if (!stackedBaseBranch || !openPRs?.length) return undefined

  // base may be remote-qualified in the badge ("fork/main") — PR heads are not.
  const baseHead = stackedBaseBranch.includes('/')
    ? (stackedBaseBranch.split('/').slice(1).join('/') || stackedBaseBranch)
    : stackedBaseBranch

  if (defaultBranch && baseHead === defaultBranch) return undefined

  const matches = openPRs.filter(pr => pr.headRefName === baseHead)
  if (matches.length !== 1) return undefined

  const pr = matches[0]
  if (!pr) return undefined

  // If other open PRs target this branch as their base, it is a long-lived
  // line (release/main/…), not a feature PR head to stack on.
  const usedAsMergeBase = openPRs.some(
    other =>
      other.number !== pr.number &&
      other.baseRefName !== undefined &&
      other.baseRefName === baseHead
  )
  if (usedAsMergeBase) return undefined

  return pr
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
