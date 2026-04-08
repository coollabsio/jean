import { useMemo } from 'react'
import { useAllSessions } from '@/services/chat'
import { isUnread } from '@/lib/session-utils'

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
