import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePlanState } from './usePlanState'
import type { ChatMessage, ContentBlock, ToolCall } from '@/types/chat'

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
        currentToolCalls: [],
        currentStreamingContent: '',
        currentStreamingContentBlocks: [],
        isSending: false,
      })
    )

    expect(result.current.pendingPlanMessage).toBe(planMessage)
    expect(result.current.hasPendingPlanApproval).toBe(true)
  })

  it('prefers streaming assistant plan text over explanation-only tool fallback', () => {
    const currentToolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          explanation: 'Repo inspected. Native plan had no prose body.',
          steps: [{ step: 'Clarify scope', status: 'in_progress' }],
        },
      },
    ]

    const currentStreamingContentBlocks: ContentBlock[] = [
      { type: 'tool_use', tool_call_id: 'plan-1' },
      {
        type: 'text',
        text: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
      },
    ]

    const { result } = renderHook(() =>
      usePlanState({
        sessionMessages: [] as ChatMessage[],
        currentToolCalls,
        currentStreamingContent:
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
        currentStreamingContentBlocks,
        isSending: true,
      })
    )

    expect(result.current.hasPendingPlanApproval).toBe(false)
    expect(result.current.latestPlanContent).toBe(
      'Plan:\n- Implement changes\n- Add tests'
    )
  })
})
