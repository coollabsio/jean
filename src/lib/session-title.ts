const DEFAULT_SESSION_NAME = /^Session \d+$/

/**
 * Title for a session row in single session view. The only open session of a
 * worktree shows the worktree name until it gets a real name, so rows do not
 * all read "Session 1".
 */
export function sessionRowTitle(
  sessionName: string,
  worktreeName: string,
  openSessionCount: number
): string {
  return openSessionCount <= 1 && DEFAULT_SESSION_NAME.test(sessionName)
    ? worktreeName
    : sessionName
}
