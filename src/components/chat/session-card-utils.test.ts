import { describe, expect, it } from 'vitest'
import {
  computeSessionCardData,
  type ChatStoreState,
} from './session-card-utils'
import type { Session } from '@/types/chat'

describe('computeSessionCardData', () => {
  it('uses streaming assistant plan text for card planContent', () => {
    const session: Session = {
      id: 'session-1',
      name: 'Test session',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
      selected_execution_mode: 'plan',
    }

    const storeState: ChatStoreState = {
      sendingSessionIds: { 'session-1': true },
      executingModes: { 'session-1': 'plan' },
      executionModes: { 'session-1': 'plan' },
      activeToolCalls: {
        'session-1': [
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              explanation: 'Repo inspected. Native plan had no prose body.',
              steps: [{ step: 'Clarify scope', status: 'in_progress' }],
            },
          },
        ],
      },
      streamingContents: {
        'session-1':
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
      },
      streamingContentBlocks: {
        'session-1': [
          { type: 'tool_use', tool_call_id: 'plan-1' },
          {
            type: 'text',
            text: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
          },
        ],
      },
      answeredQuestions: {},
      waitingForInputSessionIds: {},
      reviewingSessions: {},
      pendingPermissionDenials: {},
      sessionDigests: {},
      sessionLabels: {},
    }

    const card = computeSessionCardData(session, storeState)

    expect(card.planContent).toBe('Plan:\n- Implement changes\n- Add tests')
    expect(card.hasExitPlanMode).toBe(true)
    expect(card.isWaiting).toBe(true)
  })
})
