/**
 * Branch rows in the New Worktree dialog.
 * `qualified` is the git ref (`upstream/feature/login`) and the stable identity.
 */
export interface RemoteBranch {
  remote: string
  name: string
  qualified: string
}

export function worktreeBranchRemoteCount(branches: RemoteBranch[]): number {
  return new Set(branches.map(branch => branch.remote).filter(remote => remote.length > 0))
    .size
}

/**
 * Single-remote projects keep the short branch name so worktree creation
 * matches the previous origin-only path. Multiple remotes check out the
 * qualified ref so `main` on origin and upstream stay distinct.
 */
export function worktreeBranchCheckoutRef(
  branch: RemoteBranch,
  remoteCount: number
): string {
  if (remoteCount > 1 && branch.remote && branch.qualified) {
    return branch.qualified
  }
  return branch.name
}

/**
 * Base-branch picker value. Origin stays a short name so the default-branch
 * checkout does not become `origin/main`. Other remotes stay qualified.
 */
export function worktreeBaseBranchOption(branch: RemoteBranch): string {
  if (!branch.remote || branch.remote === 'origin') return branch.name
  return branch.qualified || branch.name
}

/** True when this row is the GitHub item currently being turned into a worktree. */
export function isSameGitHubCreateTarget(
  item: { number: number; repo?: string | null },
  creatingNumber: number | null,
  creatingRepo?: string | null
): boolean {
  if (creatingNumber !== item.number) return false
  if (!creatingRepo) return true
  return creatingRepo === item.repo
}

export function filterWorktreeBranches(
  branches: RemoteBranch[],
  defaultBranch: string | undefined,
  query: string
): RemoteBranch[] {
  const remotes = new Set(
    branches.map(branch => branch.remote).filter(remote => remote.length > 0)
  )
  const primary = remotes.has('origin') ? 'origin' : [...remotes][0]
  const q = query.trim().toLowerCase()

  return branches.filter(branch => {
    if (defaultBranch && branch.name === defaultBranch) {
      const onlyRemote = remotes.size <= 1
      const isPrimary = branch.remote === primary || branch.remote === ''
      if (onlyRemote || isPrimary) return false
    }
    if (!q) return true
    return (
      branch.name.toLowerCase().includes(q) ||
      branch.remote.toLowerCase().includes(q) ||
      branch.qualified.toLowerCase().includes(q)
    )
  })
}

/** True when an item should reuse a worktree that was created from the primary remote. */
export function reusesPrimaryGitHubSource(
  item: { remote?: string | null },
  hasMultipleRemotes: boolean,
  primaryRemote: string | null
): boolean {
  if (!hasMultipleRemotes) return true
  if (!item.remote || !primaryRemote) return !item.remote
  return item.remote === primaryRemote
}

export function primaryGitHubRemote(
  items: { remote?: string | null }[]
): string | null {
  const remotes = new Set(
    items
      .map(item => item.remote?.trim())
      .filter((remote): remote is string => Boolean(remote))
  )
  if (remotes.size === 0) return null
  if (remotes.has('origin')) return 'origin'
  return [...remotes][0] ?? null
}

export function distinctGitHubRepos(items: { repo?: string | null }[]): string[] {
  const seen = new Set<string>()
  const repos: string[] = []
  for (const item of items) {
    const repo = item.repo?.trim()
    if (!repo || seen.has(repo)) continue
    seen.add(repo)
    repos.push(repo)
  }
  return repos
}
