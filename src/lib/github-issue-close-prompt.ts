import type { LoadedIssueContext } from '@/types/github'

export function buildCommentAndCloseIssuePrompt(
  issues: LoadedIssueContext[]
): string {
  const targets = issues
    .map(issue => `${issue.repoOwner}/${issue.repoName}#${issue.number}`)
    .join(', ')
  return `For these GitHub issues only: ${targets}, add a brief comment that references the fix (for example "Fixed in <commit SHA>", a PR link, or another relevant reference). Use what you already know from this session; do not look up the latest commit. Then close only these issues. Do not change any other issue.`
}
