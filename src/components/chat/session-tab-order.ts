import type { Session, WorktreeSessions } from '@/types/chat'
import type { SessionCardData, SessionStatus } from './session-card-utils'

const RUNNING_STATUSES: readonly SessionStatus[] = [
  'planning',
  'vibing',
  'yoloing',
  'reviewing',
]

function isRunning(card: SessionCardData): boolean {
  return RUNNING_STATUSES.includes(card.status)
}

/** Code Review first, then running sessions, then most recently updated. */
export function sortSessionCardsForTabs(
  cards: SessionCardData[]
): SessionCardData[] {
  return [...cards].sort((a, b) => {
    const aIsCodeReview = a.session.name.startsWith('Code Review')
    const bIsCodeReview = b.session.name.startsWith('Code Review')
    if (aIsCodeReview !== bIsCodeReview) return aIsCodeReview ? -1 : 1

    const aIsRunning = isRunning(a)
    const bIsRunning = isRunning(b)
    if (aIsRunning !== bIsRunning) return aIsRunning ? -1 : 1

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
 *
 * Drop the store's session only when it is confirmed gone (the direct lookup
 * failed), so a stale id never leaves the tab row without a selection.
 */
export function resolveModalSessionId(
  activeSessionId: string | undefined,
  sessionIds: readonly string[],
  backendActiveSessionId?: string | null,
  activeSessionGone = false
): string | null {
  if (activeSessionId && !activeSessionGone) return activeSessionId
  if (backendActiveSessionId && sessionIds.includes(backendActiveSessionId)) {
    return backendActiveSessionId
  }
  return sessionIds[0] ?? null
}

/**
 * Seed the client selection from persisted session data without replacing a
 * selection that the user already made. A sessions-list refresh can
 * temporarily omit the running session, so list membership is not evidence
 * that the current selection is invalid.
 */
export function resolveInitialActiveSessionId(
  currentActiveSessionId: string | undefined,
  backendActiveSessionId: string | null,
  sessionIds: readonly string[]
): string | null {
  if (currentActiveSessionId) return null
  return backendActiveSessionId ?? sessionIds[0] ?? null
}

/**
 * Keep the open session in the tab row when the worktree list is empty or
 * still loading. Chat already renders from the active session id.
 */
export function sessionsForTabBar(
  sessions: readonly Session[],
  activeSession: Session | null | undefined
): Session[] {
  if (!activeSession) return [...sessions]
  if (sessions.some(session => session.id === activeSession.id)) {
    return [...sessions]
  }
  return [...sessions, activeSession]
}

/** Add one known session to a list cache without dropping sessions already there. */
export function mergeSessionIntoWorktreeSessions(
  current: WorktreeSessions | undefined,
  worktreeId: string,
  session: Session
): WorktreeSessions {
  if (current?.sessions.some(item => item.id === session.id)) return current
  return {
    worktree_id: current?.worktree_id || worktreeId,
    sessions: current ? [...current.sessions, session] : [session],
    active_session_id: current?.active_session_id ?? session.id,
    version: current?.version ?? 2,
    branch_naming_completed: current?.branch_naming_completed ?? false,
  }
}
