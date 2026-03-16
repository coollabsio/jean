/**
 * PR status polling service
 *
 * This module provides hooks to listen for PR status updates from the
 * Rust backend and cache them using TanStack Query.
 */

import { listen, type UnlistenFn, useWsConnectionStatus } from '@/lib/transport'
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { isTauri, updateWorktreeCachedStatus } from '@/services/projects'
import type { PrStatusEvent } from '@/types/pr-status'

// ============================================================================
// Query Keys
// ============================================================================

export const prStatusQueryKeys = {
  all: ['pr-status'] as const,
  worktree: (worktreeId: string) =>
    [...prStatusQueryKeys.all, worktreeId] as const,
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to listen for PR status update events from the backend.
 *
 * This hook sets up an event listener for 'pr:status-update' events
 * and updates the query cache with the new status.
 */
export function usePrStatusEvents(
  onStatusUpdate?: (status: PrStatusEvent) => void
) {
  const queryClient = useQueryClient()
  const wsConnected = useWsConnectionStatus()

  useEffect(() => {
    if (!isTauri()) return

    const unlistenPromises: Promise<UnlistenFn>[] = []

    // Listen for PR status updates
    unlistenPromises.push(
      listen<PrStatusEvent>('pr:status-update', event => {
        const status = event.payload

        // Update the query cache
        queryClient.setQueryData(
          prStatusQueryKeys.worktree(status.worktree_id),
          status
        )

        // Persist to worktree cached status (fire and forget)
        updateWorktreeCachedStatus(
          status.worktree_id,
          null, // branch - handled by git-status service
          status.display_status,
          status.check_status,
          null, // behind_count - handled by git-status service
          null // ahead_count - handled by git-status service
        ).catch(() => {
          /* silent */
        })

        // Call the optional callback
        onStatusUpdate?.(status)
      })
    )

    // Cleanup listeners on unmount
    const unlistens: UnlistenFn[] = []
    Promise.all(unlistenPromises).then(fns => {
      unlistens.push(...fns)
    })

    return () => {
      unlistens.forEach(unlisten => unlisten())
    }
  }, [queryClient, onStatusUpdate, wsConnected])
}

/**
 * Hook to get the cached PR status for a worktree.
 *
 * This returns the most recent PR status update from the background polling.
 * Returns undefined if no status has been received yet.
 */
export function usePrStatus(worktreeId: string | null) {
  return useQuery({
    queryKey: worktreeId
      ? prStatusQueryKeys.worktree(worktreeId)
      : ['pr-status', 'none'],
    queryFn: () => null as PrStatusEvent | null, // Status comes from events, not fetching
    enabled: !!worktreeId,
    staleTime: Infinity, // Never refetch automatically; data comes from events
  })
}
