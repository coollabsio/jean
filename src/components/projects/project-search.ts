import type { Project, Worktree } from '@/types/projects'

function includesQuery(values: unknown[], query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true

  return values.some(value =>
    String(value ?? '')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  )
}

export function matchesProjectSearch(project: Project, query: string): boolean {
  return includesQuery(
    [project.name, project.path, project.default_branch, project.serverName],
    query
  )
}

export function matchesWorktreeSearch(
  worktree: Worktree,
  query: string
): boolean {
  return includesQuery(
    [
      worktree.name,
      worktree.path,
      worktree.branch,
      worktree.base_branch,
      worktree.linear_issue_identifier,
      worktree.issue_number,
      worktree.pr_number,
      worktree.advisory_ghsa_id,
      worktree.security_alert_number,
      ...(worktree.labels?.map(label => label.name) ?? []),
    ],
    query
  )
}
