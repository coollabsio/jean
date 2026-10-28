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
