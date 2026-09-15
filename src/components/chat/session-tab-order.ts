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
 * Keep the store's active session while session-list queries refresh. A
 * transient response can be empty or omit the active session. Selecting the
 * first returned session here would move the user without an explicit action.
 * Removal handlers select the next session before they clear the old one.
 */
export function resolveModalSessionId(
  activeSessionId: string | undefined,
  sessionIds: readonly string[]
): string | null {
  if (activeSessionId) return activeSessionId
  return sessionIds[0] ?? null
}
