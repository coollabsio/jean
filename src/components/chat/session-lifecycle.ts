import type { Session, WorktreeSessions } from '@/types/chat'
import {
  isActionableWaitingStatus,
  type SessionCardData,
  type SessionStatus,
  type StatusGroup,
} from './session-card-utils'

const RUNNING_STATUSES: readonly SessionStatus[] = [
  'planning',
  'vibing',
  'yoloing',
  'reviewing',
]

function isRunning(card: SessionCardData): boolean {
  return RUNNING_STATUSES.includes(card.status)
}

/** Running, scheduled, or waiting for the user: a sub-session still at work. */
export function isSessionBusy(status: SessionStatus): boolean {
  return (
    RUNNING_STATUSES.includes(status) ||
    status === 'scheduled' ||
    isActionableWaitingStatus(status)
  )
}

/** The fields that link a sub-session to the session that started it. */
interface SessionLink {
  id: string
  delegated_by?: { origin_session_id: string } | null
}

/** Sub-sessions indent at most this many levels. */
export const MAX_SUB_SESSION_DEPTH = 2

export interface NestedItem<T> {
  item: T
  /** Indent level, 0 for top level, capped at `MAX_SUB_SESSION_DEPTH`. */
  depth: number
  /** Direct sub-sessions in the list. */
  childCount: number
  /** Inside a collapsed lead. */
  hidden: boolean
  /** Has sub-sessions and none of them is busy, so they may be hidden. */
  collapsible: boolean
  /** Its sub-sessions are hidden. */
  collapsed: boolean
}

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * Put each sub-session right after its lead session, keeping the incoming
 * order among siblings. A sub-session whose lead is not in the list stays at
 * top level. A lead with a busy sub-session (at any depth) never collapses,
 * so no running or waiting work is hidden. Every item appears exactly once,
 * even with a broken or cyclic lead chain.
 */
export function nestUnderLeads<T>(
  items: readonly T[],
  sessionOf: (item: T) => SessionLink,
  {
    collapsedLeadIds = NO_IDS,
    isBusy = () => false,
  }: {
    collapsedLeadIds?: ReadonlySet<string>
    isBusy?: (item: T) => boolean
  } = {}
): NestedItem<T>[] {
  const ids = new Set(items.map(item => sessionOf(item).id))
  const leadIdOf = (item: T): string | null => {
    const { id, delegated_by } = sessionOf(item)
    const leadId = delegated_by?.origin_session_id
    return leadId && leadId !== id && ids.has(leadId) ? leadId : null
  }
  const childrenOf = new Map<string, T[]>()
  for (const item of items) {
    const leadId = leadIdOf(item)
    if (!leadId) continue
    const siblings = childrenOf.get(leadId)
    if (siblings) siblings.push(item)
    else childrenOf.set(leadId, [item])
  }

  const busyBelow = new Map<string, boolean>()
  const hasBusyDescendant = (id: string, path: Set<string>): boolean => {
    const known = busyBelow.get(id)
    if (known !== undefined) return known
    path.add(id)
    const busy = (childrenOf.get(id) ?? []).some(child => {
      const childId = sessionOf(child).id
      if (path.has(childId)) return false
      return isBusy(child) || hasBusyDescendant(childId, path)
    })
    path.delete(id)
    busyBelow.set(id, busy)
    return busy
  }

  const result: NestedItem<T>[] = []
  const visited = new Set<string>()
  const emit = (item: T, depth: number, hidden: boolean) => {
    const id = sessionOf(item).id
    if (visited.has(id)) return
    visited.add(id)
    const children = childrenOf.get(id) ?? []
    const collapsible = children.length > 0 && !hasBusyDescendant(id, new Set())
    const collapsed = collapsible && collapsedLeadIds.has(id)
    result.push({
      item,
      depth: Math.min(depth, MAX_SUB_SESSION_DEPTH),
      childCount: children.length,
      hidden,
      collapsible,
      collapsed,
    })
    for (const child of children) emit(child, depth + 1, hidden || collapsed)
  }

  for (const item of items) if (!leadIdOf(item)) emit(item, 0, false)
  // Items left over sit in a lead cycle: show each cycle from its first item.
  for (const item of items) emit(item, 0, false)
  return result
}

export interface NestedStatusGroup extends Omit<StatusGroup, 'cards'> {
  rows: NestedItem<SessionCardData>[]
}

/**
 * Status groups with sub-sessions moved under their lead. A sub-session shows
 * in its lead's group, whatever its own status; a group left without rows
 * disappears.
 */
export function nestStatusGroups(
  groups: readonly StatusGroup[],
  collapsedLeadIds: ReadonlySet<string>
): NestedStatusGroup[] {
  const groupOf = new Map<string, StatusGroup>()
  for (const group of groups) {
    for (const card of group.cards) groupOf.set(card.session.id, group)
  }
  const nested = nestUnderLeads(
    groups.flatMap(group => group.cards),
    card => card.session,
    { collapsedLeadIds, isBusy: card => isSessionBusy(card.status) }
  )
  const result: NestedStatusGroup[] = []
  for (const row of nested) {
    const group = row.depth === 0 ? groupOf.get(row.item.session.id) : null
    const last = result.at(-1)
    if (group && group.key !== last?.key) {
      const { cards: _cards, ...header } = group
      result.push({ ...header, rows: [row] })
    } else {
      last?.rows.push(row)
    }
  }
  return result
}

/** The leads above `sessionId` in the list, nearest first. */
export function leadIdsOf<T>(
  sessionId: string,
  items: readonly T[],
  sessionOf: (item: T) => SessionLink
): string[] {
  const leadById = new Map(
    items.map(item => {
      const session = sessionOf(item)
      return [session.id, session.delegated_by?.origin_session_id] as const
    })
  )
  const chain: string[] = []
  let leadId = leadById.get(sessionId)
  while (
    leadId &&
    leadById.has(leadId) &&
    leadId !== sessionId &&
    !chain.includes(leadId)
  ) {
    chain.push(leadId)
    leadId = leadById.get(leadId)
  }
  return chain
}

/**
 * Sub-sessions that may close together with `leadId`: open, finished ones,
 * found through finished sub-sessions only. A busy sub-session keeps its own
 * sub-sessions.
 */
export function finishedSubSessionIds<T>(
  leadId: string,
  items: readonly T[],
  sessionOf: (item: T) => SessionLink & { archived_at?: number | null },
  isFinished: (item: T) => boolean
): string[] {
  const result: string[] = []
  const seen = new Set([leadId])
  const queue = [leadId]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const item of items) {
      const session = sessionOf(item)
      if (session.delegated_by?.origin_session_id !== current) continue
      if (seen.has(session.id) || session.archived_at) continue
      seen.add(session.id)
      if (!isFinished(item)) continue
      result.push(session.id)
      queue.push(session.id)
    }
  }
  return result
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
 * closes the worktree, except when `keepWorktree` is set: a base session
 * (and so a server) never closes. `onLastSession` is the surface policy for the last open session:
 * tabs close it (the backend then creates an empty one), Recent rows ask to
 * delete the worktree. Otherwise empty sessions close at once and the rest
 * confirm first. A lead with finished sub-sessions always confirms, so the
 * dialog can offer to close them too.
 */
export function decideSessionClose({
  target,
  sessions,
  inputDrafts,
  onLastSession,
  keepWorktree = false,
  finishedSubSessionCount = 0,
}: {
  target: {
    id: string
    message_count?: number
    archived_at?: number | null
  } | null
  sessions: readonly { id: string; archived_at?: number | null }[]
  inputDrafts: Record<string, string>
  onLastSession: 'close-session' | 'confirm-worktree'
  keepWorktree?: boolean
  finishedSubSessionCount?: number
}): SessionCloseDecision {
  if (target?.archived_at) return 'noop'
  const open = openSessions(sessions)
  if (open.length === 0) return keepWorktree ? 'noop' : 'confirm-worktree'
  if (!target) return 'noop'
  const isLast = open.every(session => session.id === target.id)
  if (isLast && onLastSession === 'confirm-worktree' && !keepWorktree) {
    return 'confirm-worktree'
  }
  return isSessionEmpty(target, inputDrafts) && finishedSubSessionCount === 0
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
