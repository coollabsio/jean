import { useMemo } from 'react'
import { useAllSessions } from '@/services/chat'
import type { Session } from '@/types/chat'

/** Check if a session counts as "unread" — has unseen activity */
function isUnread(session: Session): boolean {
  if (session.archived_at) return false

  const actionableStatuses = ['completed', 'cancelled', 'crashed']
  const hasFinishedRun =
    session.last_run_status &&
    actionableStatuses.includes(session.last_run_status)
  const isWaiting = session.waiting_for_input
  const isReviewing = session.is_reviewing

  if (!hasFinishedRun && !isWaiting && !isReviewing) return false

  if (!session.last_opened_at) return true
  return session.last_opened_at < session.updated_at
}

/** Returns the number of unread sessions across all projects */
export function useUnreadCount(): number {
  const { data: allSessions } = useAllSessions(true)

  return useMemo(() => {
    if (!allSessions) return 0

    let count = 0
    for (const entry of allSessions.entries) {
      for (const session of entry.sessions) {
        if (isUnread(session)) count++
      }
    }
    return count
  }, [allSessions])
}
