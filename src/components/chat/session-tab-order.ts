import type { SessionCardData } from './session-card-utils'

export function sortSessionCardsForTabs(
  cards: SessionCardData[]
): SessionCardData[] {
  return [...cards].sort((a, b) => {
    const aIsCodeReview = a.session.name.startsWith('Code Review')
    const bIsCodeReview = b.session.name.startsWith('Code Review')
    if (aIsCodeReview !== bIsCodeReview) return aIsCodeReview ? -1 : 1

    if (a.session.updated_at !== b.session.updated_at) {
      return b.session.updated_at - a.session.updated_at
    }
    return b.session.created_at - a.session.created_at
  })
}

/**
 * Resolve which session ChatWindow should mount in SessionChatModal.
 *
 * When the sessions query is transiently empty (invalidate after send, web
 * reconnect), keep the store's active session so ChatWindow is not unmounted —
 * unmounting blanks the modal and shows FloatingDock instead of chat input.
 */
export function resolveModalSessionId(
  activeSessionId: string | undefined,
  sessionIds: readonly string[]
): string | null {
  if (
    activeSessionId &&
    (sessionIds.length === 0 || sessionIds.includes(activeSessionId))
  ) {
    return activeSessionId
  }
  return sessionIds[0] ?? null
}
