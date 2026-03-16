import { useMemo } from 'react'
import { useChatStore } from '@/store/chat-store'
import type { ChatStoreState } from '../session-card-utils'

/**
 * Subscribe to chat store state needed for computing session card data.
 * Uses individual selectors for reliable re-renders — useShallow's useRef
 * mutation inside selectors can race with React concurrent rendering,
 * causing stale state on the canvas when multi-field store updates fire.
 */
export function useCanvasStoreState(): ChatStoreState {
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const executingModes = useChatStore(state => state.executingModes)
  const executionModes = useChatStore(state => state.executionModes)
  const activeToolCalls = useChatStore(state => state.activeToolCalls)
  const answeredQuestions = useChatStore(state => state.answeredQuestions)
  const waitingForInputSessionIds = useChatStore(
    state => state.waitingForInputSessionIds
  )
  const reviewingSessions = useChatStore(state => state.reviewingSessions)
  const pendingPermissionDenials = useChatStore(
    state => state.pendingPermissionDenials
  )
  const sessionDigests = useChatStore(state => state.sessionDigests)
  const sessionLabels = useChatStore(state => state.sessionLabels)

  return useMemo(
    () => ({
      sendingSessionIds,
      executingModes,
      executionModes,
      activeToolCalls,
      answeredQuestions,
      waitingForInputSessionIds,
      reviewingSessions,
      pendingPermissionDenials,
      sessionDigests,
      sessionLabels,
    }),
    [
      sendingSessionIds,
      executingModes,
      executionModes,
      activeToolCalls,
      answeredQuestions,
      waitingForInputSessionIds,
      reviewingSessions,
      pendingPermissionDenials,
      sessionDigests,
      sessionLabels,
    ]
  )
}
