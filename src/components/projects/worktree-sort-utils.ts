import {
  isBaseSession,
  type Worktree,
  type WorktreeSortMode,
} from '@/types/projects'
import type { Session } from '@/types/chat'

export type { WorktreeSortMode } from '@/types/projects'

/**
 * Latest real activity of a session: last run, terminal, or review activity.
 * Returns 0 for a session that was only created (for example the empty
 * session opened with a worktree), so it does not bump the worktree to the top.
 */
export function getSessionActivityTimestamp(session: Session): number {
  if (session.last_message_at) return session.last_message_at
  return session.updated_at > session.created_at ? session.updated_at : 0
}

/** Sort value for a worktree with a running session: above all others. */
const RUNNING_ACTIVITY = Number.MAX_SAFE_INTEGER

export function getWorktreeLastActivity(
  sessions: Session[],
  fallbackTimestamp: number,
  sendingSessionIds: Readonly<Record<string, boolean>> = {}
): number {
  if (sessions.some(session => sendingSessionIds[session.id])) {
    return RUNNING_ACTIVITY
  }
  return sessions.reduce(
    (latest, session) => Math.max(latest, getSessionActivityTimestamp(session)),
    fallbackTimestamp
  )
}

export function getWorktreeSortValue(
  worktree: Worktree,
  latestActivityAt: number,
  sortMode: WorktreeSortMode
): number {
  if (sortMode === 'manual') {
    return worktree.order
  }

  if (sortMode === 'created') {
    return worktree.created_at
  }

  return Math.max(latestActivityAt, worktree.created_at)
}

export function compareWorktreesForCanvasSort(
  a: Worktree,
  b: Worktree,
  latestActivityByWorktreeId: ReadonlyMap<string, number>,
  sortMode: WorktreeSortMode
): number {
  const aIsBase = isBaseSession(a)
  const bIsBase = isBaseSession(b)
  if (aIsBase && !bIsBase) return -1
  if (!aIsBase && bIsBase) return 1

  if (sortMode === 'manual') {
    const orderDiff = a.order - b.order
    if (orderDiff !== 0) return orderDiff

    const createdDiff = b.created_at - a.created_at
    if (createdDiff !== 0) return createdDiff

    return a.id.localeCompare(b.id)
  }

  const sortDiff =
    getWorktreeSortValue(
      b,
      latestActivityByWorktreeId.get(b.id) ?? b.created_at,
      sortMode
    ) -
    getWorktreeSortValue(
      a,
      latestActivityByWorktreeId.get(a.id) ?? a.created_at,
      sortMode
    )
  if (sortDiff !== 0) return sortDiff

  return b.created_at - a.created_at
}
