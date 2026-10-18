import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useActiveConnectionId } from '@/lib/remote-connections'

/**
 * Server-backed query keys are not all scoped by server. Reset them when the
 * selected Jean server changes so local data cannot leak into a remote view.
 */
export function useServerQuerySync(): void {
  const queryClient = useQueryClient()
  const activeConnectionId = useActiveConnectionId()
  const previousConnectionId = useRef(activeConnectionId)

  useEffect(() => {
    if (previousConnectionId.current === activeConnectionId) return
    previousConnectionId.current = activeConnectionId
    void queryClient.resetQueries()
  }, [activeConnectionId, queryClient])
}
