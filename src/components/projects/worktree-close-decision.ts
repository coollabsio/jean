/**
 * Pure decision logic for the middle-click close of a worktree row or a
 * conversation (session) row.
 *
 * Kept separate from the heavy `WorktreeItem` component so the branching matrix
 * (confirmation on/off, last vs. multiple sessions, empty vs. non-empty) is
 * unit-testable without rendering the full store/query tree.
 */

export type WorktreeCloseDecision = 'confirm' | 'close'

/**
 * A middle-click on a worktree row confirms before closing unless
 * `confirm_session_close` is explicitly disabled (undefined defaults to on).
 */
export function decideWorktreeMiddleClose(
  confirmSessionClose: boolean | undefined
): WorktreeCloseDecision {
  return confirmSessionClose === false ? 'close' : 'confirm'
}

export type SessionCloseDecision = 'confirm' | 'delete'

/**
 * Decide whether closing a session (tab X, middle-click, etc.) should prompt.
 *
 * When `confirm_session_close` is enabled (default), any non-empty session
 * confirms before remove — not only the last tab. Confirming only the last tab
 * let a held close shortcut cascade-delete chats with no recovery prompt
 * (GitHub issue #56). Empty sessions still close immediately.
 *
 * `activeSessionCount` is retained for call-site compatibility / future UX.
 */
export function decideSessionMiddleClose(params: {
  activeSessionCount: number
  sessionIsEmpty: boolean
  confirmSessionClose: boolean | undefined
}): SessionCloseDecision {
  const { sessionIsEmpty, confirmSessionClose } = params
  if (confirmSessionClose !== false && !sessionIsEmpty) {
    return 'confirm'
  }
  return 'delete'
}
