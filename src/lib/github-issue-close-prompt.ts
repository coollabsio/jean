import type { LoadedIssueContext } from '@/types/github'

export function buildCommentAndCloseIssuePrompt(
  issues: LoadedIssueContext[]
): string {
  const targets = issues
    .map(issue => `${issue.repoOwner}/${issue.repoName}#${issue.number}`)
    .join(', ')
  return `Find the full SHA of the latest commit on this worktree. For these GitHub issues only: ${targets}, add a comment containing exactly "Fixed in <commit SHA>" with that SHA in place of <commit SHA>. Add no other text to each comment. Then close only these issues. Do not change any other issue.`
}
