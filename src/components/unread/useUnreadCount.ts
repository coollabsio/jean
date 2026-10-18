import { useConsolidatedUnreadSessionCount } from '@/services/multi-server-sessions'

/** Returns the number of unread sessions across all projects */
export function useUnreadCount(): number {
  const { data } = useConsolidatedUnreadSessionCount()
  return data ?? 0
}
