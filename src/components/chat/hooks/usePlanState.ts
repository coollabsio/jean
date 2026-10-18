import { useMemo } from 'react'
import { isPlanToolCall } from '@/types/chat'
import type { ChatMessage } from '@/types/chat'

interface UsePlanStateParams {
  sessionMessages: ChatMessage[] | undefined
  pendingPlanMessageId?: string | null
  isSending: boolean
}

/**
 * Computes pending plan approval state from session messages.
 */
export function usePlanState({
  sessionMessages,
  pendingPlanMessageId,
  isSending,
}: UsePlanStateParams) {
  // Returns the message that has an unapproved plan awaiting action, if any
  const pendingPlanMessage = useMemo(() => {
    const messages = sessionMessages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      const isPendingPlainTextPlan = m?.id === pendingPlanMessageId
      if (
        m &&
        m.role === 'assistant' &&
        (isPendingPlainTextPlan || m.tool_calls?.some(tc => isPlanToolCall(tc)))
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
  }, [sessionMessages, pendingPlanMessageId])

  const hasPendingPlanApproval = useMemo(
    () => !!pendingPlanMessage && !isSending,
    [pendingPlanMessage, isSending]
  )

  return {
    pendingPlanMessage,
    hasPendingPlanApproval,
  }
}
