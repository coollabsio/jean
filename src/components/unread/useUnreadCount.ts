import { useAllSessions } from '@/services/chat'
import { isUnreadSession } from './unread-utils'

/** Returns the number of unread sessions across all projects */
export function useUnreadCount(): number {
  const { data } = useAllSessions()
  return (
    data?.entries.reduce(
      (total, entry) =>
        total + entry.sessions.filter(isUnreadSession).length,
      0
    ) ?? 0
  )
}
