import { useMemo } from 'react'
import { useChatStore } from '@/store/chat-store'
import type { ChatStoreState } from '../session-card-utils'

/**
 * Streaming text changes every animation frame during a run. Reading it
 * lazily through a stable getter (instead of subscribing to the maps) keeps
 * every canvas/sidebar card consumer off the per-frame re-render path —
 * cards re-read the current text whenever a subscribed field changes.
 */
const getStreamingText: ChatStoreState['getStreamingText'] = sessionId => {
  const state = useChatStore.getState()
  return {
    content: state.streamingContents[sessionId] ?? '',
    blocks: state.streamingContentBlocks[sessionId] ?? [],
  }
}

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
  const sessionStatusOverrides = useChatStore(
    state => state.sessionStatusOverrides
  )
  const pendingPermissionDenials = useChatStore(
    state => state.pendingPermissionDenials
  )
  const pendingCodexPermissionRequests = useChatStore(
    state => state.pendingCodexPermissionRequests
  )
  const pendingOpencodePermissionRequests = useChatStore(
    state => state.pendingOpencodePermissionRequests
  )
  const pendingCodexCommandApprovalRequests = useChatStore(
    state => state.pendingCodexCommandApprovalRequests
  )
  const pendingCodexUserInputRequests = useChatStore(
    state => state.pendingCodexUserInputRequests
  )
  const pendingCodexMcpElicitationRequests = useChatStore(
    state => state.pendingCodexMcpElicitationRequests
  )
  const pendingCodexDynamicToolCallRequests = useChatStore(
    state => state.pendingCodexDynamicToolCallRequests
  )
  const sessionLabels = useChatStore(state => state.sessionLabels)

  return useMemo(
    () => ({
      sendingSessionIds,
      executingModes,
      executionModes,
      activeToolCalls,
      getStreamingText,
      answeredQuestions,
      waitingForInputSessionIds,
      reviewingSessions,
      sessionStatusOverrides,
      pendingPermissionDenials,
      pendingCodexPermissionRequests,
      pendingOpencodePermissionRequests,
      pendingCodexCommandApprovalRequests,
      pendingCodexUserInputRequests,
      pendingCodexMcpElicitationRequests,
      pendingCodexDynamicToolCallRequests,
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
      sessionStatusOverrides,
      pendingPermissionDenials,
      pendingCodexPermissionRequests,
      pendingOpencodePermissionRequests,
      pendingCodexCommandApprovalRequests,
      pendingCodexUserInputRequests,
      pendingCodexMcpElicitationRequests,
      pendingCodexDynamicToolCallRequests,
      sessionLabels,
    ]
  )
}
