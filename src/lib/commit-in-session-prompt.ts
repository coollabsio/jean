/**
 * One-line prompt for the "Commit in Session" magic command. The active chat
 * backend does the commit, so it follows the same "Closes #N" setting as the
 * Commit magic prompt.
 */
export function buildCommitInSessionPrompt(
  closeIssueNumber?: number | null
): string {
  const closes = closeIssueNumber
    ? ` Add a "Closes #${closeIssueNumber}" footer line so the commit closes GitHub issue #${closeIssueNumber}.`
    : ''
  return `Commit all current changes in this worktree with a concise commit message that matches the recent commit style.${closes}`
}
