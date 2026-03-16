import { useMemo } from 'react'
import { isExitPlanMode } from '@/types/chat'
import type { ToolCall, ChatMessage } from '@/types/chat'
import { findPlanFilePath, findPlanContent } from '../tool-call-utils'

interface UsePlanStateParams {
  sessionMessages: ChatMessage[] | undefined
  currentToolCalls: ToolCall[]
  isSending: boolean
  activeSessionId: string | null | undefined
  isStreamingPlanApproved: (sessionId: string) => boolean
}

/**
 * Computes all plan-related derived state from session messages and streaming tool calls.
 */
export function usePlanState({
  sessionMessages,
  currentToolCalls,
  isSending,
  activeSessionId,
  isStreamingPlanApproved,
}: UsePlanStateParams) {
  // Returns the message that has an unapproved plan awaiting action, if any
  const pendingPlanMessage = useMemo(() => {
    const messages = sessionMessages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        m &&
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => isExitPlanMode(tc))
      ) {
        let hasFollowUp = false
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j]?.role === 'user') {
            hasFollowUp = true
            break
          }
        }
        if (!m.plan_approved && !hasFollowUp) {
          return m
        }
        break
      }
    }
    return null
  }, [sessionMessages])

  // Check if there's a streaming plan awaiting approval
  const hasStreamingPlan = useMemo(() => {
    if (!isSending || !activeSessionId) return false
    const hasExitPlanModeTool = currentToolCalls.some(isExitPlanMode)
    return hasExitPlanModeTool && !isStreamingPlanApproved(activeSessionId)
  }, [isSending, activeSessionId, currentToolCalls, isStreamingPlanApproved])

  // Find latest plan content from ExitPlanMode tool calls (primary source)
  const latestPlanContent = useMemo(() => {
    const streamingPlan = findPlanContent(currentToolCalls)
    if (streamingPlan) return streamingPlan
    const msgs = sessionMessages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.tool_calls) {
        const content = findPlanContent(m.tool_calls)
        if (content) return content
      }
    }
    return null
  }, [sessionMessages, currentToolCalls])

  // Find latest plan file path (fallback for old-style file-based plans)
  const latestPlanFilePath = useMemo(() => {
    const msgs = sessionMessages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.tool_calls) {
        const path = findPlanFilePath(m.tool_calls)
        if (path) return path
      }
    }
    return null
  }, [sessionMessages])

  return {
    pendingPlanMessage,
    hasStreamingPlan,
    latestPlanContent,
    latestPlanFilePath,
  }
}
