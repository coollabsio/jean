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

/** Code Review first, then most recently updated, with running sessions last. */
export function sortSessionCardsForTabs(
  cards: SessionCardData[]
): SessionCardData[] {
  return [...cards].sort((a, b) => {
    const aIsCodeReview = a.session.name.startsWith('Code Review')
    const bIsCodeReview = b.session.name.startsWith('Code Review')
    if (aIsCodeReview !== bIsCodeReview) return aIsCodeReview ? -1 : 1

    const aIsRunning = isRunning(a)
    const bIsRunning = isRunning(b)
    if (aIsRunning !== bIsRunning) return aIsRunning ? 1 : -1

    if (a.session.updated_at !== b.session.updated_at) {
      return b.session.updated_at - a.session.updated_at
    }
    return b.session.created_at - a.session.created_at
  })
}

/**
 * The store's active session is gone when the list has loaded and the direct
 * lookup failed or returned an archived session. Closed sessions stay on disk
 * (archived) until purge, so `get_session` still returns them.
 */
export function isActiveSessionGone(
  listLoaded: boolean,
  lookupFailed: boolean,
  lookupSession: Session | null | undefined
): boolean {
  if (!listLoaded) return false
  return lookupFailed || lookupSession?.archived_at != null
}

/** Closed sessions keep `archived_at` until the backend purges them. */
export function openSessions<T extends { archived_at?: number | null }>(
  sessions: readonly T[]
): T[] {
  return sessions.filter(session => !session.archived_at)
}

/**
 * Pick the session a worktree view should show: the current selection unless
 * it is confirmed gone, else the backend's last-used session if it is listed,
 * else the first listed session.
 *
 * List membership alone does not make the current selection gone. A refresh
 * can return an empty list or omit the running session, and selecting another
 * session then would move the user without an explicit action.
 */
export function resolveActiveSessionId({
  current,
  currentGone = false,
  backendActive,
  listedIds,
}: {
  current: string | null | undefined
  currentGone?: boolean
  backendActive: string | null | undefined
  listedIds: readonly string[]
}): string | null {
  if (current && !currentGone) return current
  if (backendActive && listedIds.includes(backendActive)) return backendActive
  return listedIds[0] ?? null
}

/**
 * The session to write to the store, or null when nothing should be written
 * yet. A backend active session missing from the cached list means the list
 * is behind it (the backend just created or switched to it). Showing the first
 * listed session meanwhile is fine, but storing it would keep that temporary
 * pick after the list refetch.
 */
export function resolvePersistedActiveSessionId(
  input: Parameters<typeof resolveActiveSessionId>[0]
): string | null {
  const { current, currentGone = false, backendActive, listedIds } = input
  const keepsCurrent = !!current && !currentGone
  if (!keepsCurrent && backendActive && !listedIds.includes(backendActive)) {
    return null
  }
  return resolveActiveSessionId(input)
}

/**
 * The tab to select when `closedId` closes: its left neighbor, else its right
 * neighbor, in the visible tab order. Closing an inactive tab keeps the
 * selection, and closing the only tab leaves the choice to the backend.
 */
export function selectNeighborAfterClose(
  sortedIds: readonly string[],
  closedId: string,
  activeId: string | null | undefined
): string | null {
  if (activeId !== closedId) return null
  const index = sortedIds.indexOf(closedId)
  if (index === -1) return null
  return sortedIds[index - 1] ?? sortedIds[index + 1] ?? null
}

/**
 * A session is empty when it has no messages and no unsent draft text.
 * Closing a non-empty session always confirms first, so a typed but unsent
 * prompt is never lost and a held close shortcut cannot cascade-delete chats
 * (GitHub issue #56).
 */
export function isSessionEmpty(
  session: { id: string; message_count?: number },
  inputDrafts: Record<string, string>
): boolean {
  return !session.message_count && !inputDrafts[session.id]?.trim()
}

export type SessionCloseDecision =
  | 'close-session'
  | 'confirm-session'
  | 'confirm-worktree'
  | 'noop'

/**
 * What closing `target` should do. With no open session left the request
 * closes the worktree, except on a server, whose one base session never
 * closes. `onLastSession` is the surface policy for the last open session:
 * tabs close it (the backend then creates an empty one), Recent rows ask to
 * delete the worktree. Otherwise empty sessions close at once and the rest
 * confirm first.
 */
export function decideSessionClose({
  target,
  sessions,
  inputDrafts,
  onLastSession,
  isServer = false,
}: {
  target: {
    id: string
    message_count?: number
    archived_at?: number | null
  } | null
  sessions: readonly { id: string; archived_at?: number | null }[]
  inputDrafts: Record<string, string>
  onLastSession: 'close-session' | 'confirm-worktree'
  isServer?: boolean
}): SessionCloseDecision {
  if (target?.archived_at) return 'noop'
  const open = openSessions(sessions)
  if (open.length === 0) return isServer ? 'noop' : 'confirm-worktree'
  if (!target) return 'noop'
  const isLast = open.every(session => session.id === target.id)
  if (isLast && onLastSession === 'confirm-worktree' && !isServer) {
    return 'confirm-worktree'
  }
  return isSessionEmpty(target, inputDrafts)
    ? 'close-session'
    : 'confirm-session'
}

export type ActiveAfterClose =
  | { kind: 'keep' }
  | { kind: 'select'; sessionId: string }
  | { kind: 'clear' }

/**
 * Apply the backend's new active session after `close_session` succeeds,
 * unless the caller already selected a neighbor. `currentActive` is read after
 * the closed session's references are cleared.
 */
export function resolveActiveAfterCloseSuccess(
  currentActive: string | undefined,
  closedId: string,
  backendNewActive: string | null
): ActiveAfterClose {
  if (!backendNewActive) return { kind: 'clear' }
  if (!currentActive || currentActive === closedId) {
    return { kind: 'select', sessionId: backendNewActive }
  }
  return { kind: 'keep' }
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
