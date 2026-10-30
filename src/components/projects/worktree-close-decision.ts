/**
 * A session is empty when it has no messages and no unsent draft text.
 * Closing a non-empty session always confirms first, so a typed but unsent
 * prompt is never lost and a held close shortcut cannot cascade-delete chats
 * (GitHub issue #56). Empty sessions close immediately.
 */
export function isSessionEmpty(
  session: { id: string; message_count?: number },
  inputDrafts: Record<string, string>
): boolean {
  return !session.message_count && !inputDrafts[session.id]?.trim()
}

export type SessionRowCloseAction =
  | 'close-session'
  | 'confirm-session'
  | 'confirm-worktree'

/**
 * CMD+W on a session row of the single session view list. Closing the last
 * open session asks to delete the whole worktree. Other sessions follow the
 * tab rules: empty ones close at once, the rest confirm first.
 */
export function decideSessionRowClose(
  session: { id: string; message_count?: number },
  worktreeSessions: { id: string; archived_at?: number | null }[],
  inputDrafts: Record<string, string>
): SessionRowCloseAction {
  const openSessions = worktreeSessions.filter(s => !s.archived_at)
  if (openSessions.every(s => s.id === session.id)) return 'confirm-worktree'
  return isSessionEmpty(session, inputDrafts)
    ? 'close-session'
    : 'confirm-session'
}
