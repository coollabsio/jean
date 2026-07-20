import type { SessionCardData } from './session-card-utils'

const STATUS_PRIORITY: Record<string, number> = {
  waiting: 0,
  permission: 0,
  planning: 1,
  vibing: 2,
  yoloing: 3,
  reviewing: 4,
  review: 4,
  completed: 4,
  idle: 5,
}

export function sortSessionCardsForTabs(
  cards: SessionCardData[]
): SessionCardData[] {
  return [...cards].sort((a, b) => {
    const aIsCodeReview = a.session.name.startsWith('Code Review')
    const bIsCodeReview = b.session.name.startsWith('Code Review')
    if (aIsCodeReview !== bIsCodeReview) return aIsCodeReview ? -1 : 1

    const pa = STATUS_PRIORITY[a.status] ?? 1
    const pb = STATUS_PRIORITY[b.status] ?? 1
    if (pa !== pb) return pa - pb
    if (a.session.order !== b.session.order) {
      return a.session.order - b.session.order
    }
    return a.session.created_at - b.session.created_at
  })
}

export function buildReorderedSessionIdsWithinStatus(
  sortedCards: SessionCardData[],
  draggedSessionId: string,
  targetSessionId: string
): string[] | null {
  if (draggedSessionId === targetSessionId) return null

  const dragged = sortedCards.find(card => card.session.id === draggedSessionId)
  const target = sortedCards.find(card => card.session.id === targetSessionId)
  if (!dragged || !target || dragged.status !== target.status) return null

  const ids = sortedCards.map(card => card.session.id)
  const fromIndex = ids.indexOf(draggedSessionId)
  const toIndex = ids.indexOf(targetSessionId)
  if (fromIndex === -1 || toIndex === -1) return null

  ids.splice(fromIndex, 1)
  ids.splice(toIndex, 0, draggedSessionId)
  return ids
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
