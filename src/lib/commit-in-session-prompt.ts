/**
 * One-line prompt for the "Commit in Session" magic command. The active chat
 * backend does the commit, so it follows the same "Closes #N" setting as the
 * Commit magic prompt, for the worktree issue and any issue loaded in context.
 */
export function buildCommitInSessionPrompt(
  closeIssueNumbers: number[]
): string {
  const numbers = [...new Set(closeIssueNumbers)]
  const footers = numbers.map(n => `"Closes #${n}"`).join(', ')
  const closes = numbers.length
    ? ` Add a footer line for each linked GitHub issue so the commit closes it: ${footers}.`
    : ''
  return `Commit the current session changes with a concise commit message that matches the recent commit style. The branch could have other changes unrelated to this session, so make sure you commit only the right ones.${closes}`
}
