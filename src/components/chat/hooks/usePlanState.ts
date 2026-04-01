import { useMemo } from 'react'
import { isPlanToolCall } from '@/types/chat'
import type { ToolCall, ChatMessage, ContentBlock } from '@/types/chat'
import { findPlanFilePath, resolvePlanContent } from '../tool-call-utils'

interface UsePlanStateParams {
  sessionMessages: ChatMessage[] | undefined
  currentToolCalls: ToolCall[]
  currentStreamingContent: string
  currentStreamingContentBlocks: ContentBlock[]
  isSending: boolean
}

/**
 * Computes all plan-related derived state from session messages and streaming tool calls.
 */
export function usePlanState({
  sessionMessages,
  currentToolCalls,
  currentStreamingContent,
  currentStreamingContentBlocks,
  isSending,
}: UsePlanStateParams) {
  // Returns the message that has an unapproved plan awaiting action, if any
  const pendingPlanMessage = useMemo(() => {
    const messages = sessionMessages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        m &&
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => isPlanToolCall(tc))
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

  const hasPendingPlanApproval = useMemo(
    () => !!pendingPlanMessage && !isSending,
    [pendingPlanMessage, isSending]
  )

  // Find latest plan content from ExitPlanMode tool calls (primary source)
  const latestPlanContent = useMemo(() => {
    const streamingPlan = resolvePlanContent({
      toolCalls: currentToolCalls,
      messageContent: currentStreamingContent,
      contentBlocks: currentStreamingContentBlocks,
    }).content
    if (streamingPlan) return streamingPlan
    const msgs = sessionMessages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.tool_calls) {
        const content = resolvePlanContent({
          toolCalls: m.tool_calls,
          messageContent: m.content,
          contentBlocks: m.content_blocks,
        }).content
        if (content) return content
      }
    }
    return null
  }, [
    sessionMessages,
    currentToolCalls,
    currentStreamingContent,
    currentStreamingContentBlocks,
  ])

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
    hasPendingPlanApproval,
    latestPlanContent,
    latestPlanFilePath,
  }
}
