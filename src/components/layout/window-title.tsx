/**
 * Title shown in the mobile title bar and the web browser tab. Project pages
 * use the project, and on desktop also the worktree.
 */
export function resolveWindowTitle({
  projectName,
  worktreeName,
  worktreeBranch,
  isMobile,
}: {
  projectName?: string | null
  worktreeName?: string | null
  worktreeBranch?: string | null
  isMobile: boolean
}): string {
  if (!projectName || !worktreeName) return 'Jean'
  if (isMobile) return projectName
  const branchSuffix =
    worktreeBranch && worktreeBranch !== worktreeName
      ? ` (${worktreeBranch})`
      : ''
  return `${projectName} › ${worktreeName}${branchSuffix}`
}
