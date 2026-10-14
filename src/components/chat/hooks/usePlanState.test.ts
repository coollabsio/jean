import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePlanState } from './usePlanState'
import type { ChatMessage } from '@/types/chat'

describe('usePlanState', () => {
  it('finds a pending plain-text plan by its persisted message id', () => {
    const planMessage: ChatMessage = {
      id: 'plan-message-1',
      session_id: 'session-1',
      role: 'assistant',
      content: 'Plan:\n- Implement the fix\n- Add tests',
      timestamp: 1,
      tool_calls: [],
    }

    const { result } = renderHook(() =>
      usePlanState({
        sessionMessages: [planMessage],
        pendingPlanMessageId: planMessage.id,
        isSending: false,
      })
    )

    expect(result.current.pendingPlanMessage).toBe(planMessage)
    expect(result.current.hasPendingPlanApproval).toBe(true)
  })
})
