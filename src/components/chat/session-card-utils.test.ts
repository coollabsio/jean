import { describe, expect, it } from 'vitest'
import {
  buildNativeClientSessionInput,
  computeSessionCardData,
  getEffectiveSessionWaiting,
  getResumeArgs,
  isDedicatedEmptyCodeReviewSession,
  shouldShowCodeReviewLoadingPanel,
  shouldShowReviewFullWidth,
  statusConfig,
  type ChatStoreState,
} from './session-card-utils'
import type { ContentBlock, Session } from '@/types/chat'

describe('native client resume sessions', () => {
  const session: Session = {
    id: 'session-1',
    name: 'Fix dashboard bug',
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    backend: 'codex',
    codex_thread_id: 'thread-123',
  }

  it('builds a Codex resume launch without requiring a prior terminal command', () => {
    expect(getResumeArgs(session)).toEqual({
      command: 'codex',
      args: ['resume', 'thread-123'],
    })
  })

  it('builds a separate Jean terminal session for the native client', () => {
    expect(
      buildNativeClientSessionInput(session, 'worktree-1', '/tmp/worktree-1')
    ).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      name: 'Fix dashboard bug (Native)',
      backend: 'codex',
      primarySurface: 'terminal',
      terminalCommand: 'codex',
      terminalCommandArgs: ['resume', 'thread-123'],
      terminalLabel: 'Fix dashboard bug (Native)',
      nativeSessionId: 'thread-123',
    })
  })

  it('builds a Grok resume launch with --resume (not --session-id)', () => {
    const grokSession: Session = {
      ...session,
      name: 'Grok tool call support',
      backend: 'grok',
      codex_thread_id: undefined,
      grok_session_id: 'grok-acp-1',
    }

    expect(getResumeArgs(grokSession)).toEqual({
      command: 'grok',
      args: ['--resume', 'grok-acp-1'],
    })
    expect(
      buildNativeClientSessionInput(
        grokSession,
        'worktree-1',
        '/tmp/worktree-1'
      )
    ).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      name: 'Grok tool call support (Native)',
      backend: 'grok',
      primarySurface: 'terminal',
      terminalCommand: 'grok',
      terminalCommandArgs: ['--resume', 'grok-acp-1'],
      terminalLabel: 'Grok tool call support (Native)',
      nativeSessionId: 'grok-acp-1',
    })
  })

  it('builds a Kimi Code resume launch with --session', () => {
    const kimiSession: Session = {
      ...session,
      name: 'Kimi ACP support',
      backend: 'kimi',
      codex_thread_id: undefined,
      kimi_session_id: 'kimi-acp-1',
    }

    expect(getResumeArgs(kimiSession)).toEqual({
      command: 'kimi',
      args: ['--session', 'kimi-acp-1'],
    })
    expect(
      buildNativeClientSessionInput(
        kimiSession,
        'worktree-1',
        '/tmp/worktree-1'
      )
    ).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      name: 'Kimi ACP support (Native)',
      backend: 'kimi',
      primarySurface: 'terminal',
      terminalCommand: 'kimi',
      terminalCommandArgs: ['--session', 'kimi-acp-1'],
      terminalLabel: 'Kimi ACP support (Native)',
      nativeSessionId: 'kimi-acp-1',
    })
  })
})

describe('computeSessionCardData', () => {
  function createBaseSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'session-1',
      name: 'Test session',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
      selected_execution_mode: 'plan',
      ...overrides,
    }
  }

  function streamingTextGetter(
    contents: Record<string, string> = {},
    blocks: Record<string, ContentBlock[]> = {}
  ): ChatStoreState['getStreamingText'] {
    return sessionId => ({
      content: contents[sessionId] ?? '',
      blocks: blocks[sessionId] ?? [],
    })
  }

  function createBaseStoreState(
    overrides: Partial<ChatStoreState> = {}
  ): ChatStoreState {
    return {
      sendingSessionIds: {},
      executingModes: {},
      executionModes: {},
      activeToolCalls: {},
      getStreamingText: streamingTextGetter(),
      answeredQuestions: {},
      waitingForInputSessionIds: {},
      reviewingSessions: {},
      pendingPermissionDenials: {},
      sessionLabels: {},
      ...overrides,
    }
  }

  it('keeps streaming codex plans in planning status until the run actually pauses', () => {
    const session = createBaseSession()

    const storeState = createBaseStoreState({
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
      getStreamingText: streamingTextGetter(
        {
          'session-1':
            'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
        },
        {
          'session-1': [
            { type: 'tool_use', tool_call_id: 'plan-1' },
            {
              type: 'text',
              text: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
            },
          ],
        }
      ),
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.planContent).toBe('Plan:\n- Implement changes\n- Add tests')
    expect(card.hasExitPlanMode).toBe(true)
    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('planning')
  })

  it('uses streaming assistant plan text for actionable waiting plan cards', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: true,
      waiting_for_input_type: 'plan',
    }

    const storeState: ChatStoreState = {
      ...createBaseStoreState(),
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
      getStreamingText: streamingTextGetter(
        {
          'session-1':
            'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
        },
        {
          'session-1': [
            { type: 'tool_use', tool_call_id: 'plan-1' },
            {
              type: 'text',
              text: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
            },
          ],
        }
      ),
    }

    const card = computeSessionCardData(session, storeState)

    expect(card.planContent).toBe('Plan:\n- Implement changes\n- Add tests')
    expect(card.hasExitPlanMode).toBe(true)
    expect(card.isWaiting).toBe(true)
    expect(card.status).toBe('waiting')
  })

  it('ignores stale Zustand waiting flag when session is completed and reviewing', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: false,
      is_reviewing: true,
      last_run_status: 'completed',
      last_run_execution_mode: 'plan',
    }
    const storeState = createBaseStoreState({
      waitingForInputSessionIds: { 'session-1': true },
      reviewingSessions: { 'session-1': true },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('review')
  })

  it('shows an unopened code review session as loading from persisted state', () => {
    const session = createBaseSession({
      name: 'Code Review · Codex · gpt-5.6-sol',
      is_reviewing: true,
    })

    const card = computeSessionCardData(session, createBaseStoreState())

    expect(card.status).toBe('reviewing')
    expect(statusConfig[card.status]).toMatchObject({
      indicatorStatus: 'running',
      indicatorVariant: 'loading',
    })
  })

  it('ignores stale Zustand waiting flag when remote run completed normally', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: false,
      is_reviewing: false,
      last_run_status: 'completed',
      last_run_execution_mode: 'build',
    }
    const storeState = createBaseStoreState({
      waitingForInputSessionIds: { 'session-1': true },
    })

    const card = computeSessionCardData(session, storeState)

    expect(getEffectiveSessionWaiting(session, storeState)).toBe(false)
    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('completed')
  })

  it('does not treat a normal reviewed session as a code review loading panel', () => {
    const session: Session = {
      ...createBaseSession(),
      is_reviewing: true,
      last_run_status: 'completed',
    }

    expect(
      shouldShowCodeReviewLoadingPanel({
        session,
        isSessionReviewing: true,
        hasReviewResults: false,
      })
    ).toBe(false)
  })

  it('shows the code review loading panel for an empty backend-created review session', () => {
    const session: Session = {
      ...createBaseSession({
        name: 'Code Review',
        is_reviewing: true,
      }),
    }

    expect(
      shouldShowCodeReviewLoadingPanel({
        session,
        isSessionReviewing: true,
        hasReviewResults: false,
      })
    ).toBe(true)
  })

  it('identifies dedicated empty Code Review sessions (no chat transcript)', () => {
    expect(
      isDedicatedEmptyCodeReviewSession(
        createBaseSession({ name: 'Code Review · Codex · gpt-5.6-sol' })
      )
    ).toBe(true)
    expect(
      isDedicatedEmptyCodeReviewSession(
        createBaseSession({
          name: 'Code Review',
          messages: [
            {
              id: 'm1',
              session_id: 'session-1',
              role: 'user',
              content: 'hi',
              timestamp: 1,
              tool_calls: [],
            },
          ],
        })
      )
    ).toBe(false)
    expect(
      isDedicatedEmptyCodeReviewSession(
        createBaseSession({ name: 'Session 1' })
      )
    ).toBe(false)
  })

  it('uses full-width review on mobile only for dedicated empty Code Review', () => {
    const emptyReview = createBaseSession({
      name: 'Code Review',
      is_reviewing: true,
    })
    const normalSession = createBaseSession({ name: 'Session 1' })

    expect(
      shouldShowReviewFullWidth({
        hasReviewPanel: true,
        reviewSidebarVisible: true,
        isMobile: true,
        session: emptyReview,
      })
    ).toBe(true)

    expect(
      shouldShowReviewFullWidth({
        hasReviewPanel: true,
        reviewSidebarVisible: true,
        isMobile: true,
        session: normalSession,
      })
    ).toBe(false)

    expect(
      shouldShowReviewFullWidth({
        hasReviewPanel: true,
        reviewSidebarVisible: true,
        isMobile: false,
        session: normalSession,
      })
    ).toBe(true)

    expect(
      shouldShowReviewFullWidth({
        hasReviewPanel: true,
        reviewSidebarVisible: false,
        isMobile: true,
        session: emptyReview,
      })
    ).toBe(false)
  })

  it('ignores stale persisted waiting_for_input on completed non-plan run', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: true,
      waiting_for_input_type: null,
      last_run_status: 'completed',
      last_run_execution_mode: 'yolo',
    }
    const storeState = createBaseStoreState()

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(false)
    expect(card.status).not.toBe('waiting')
  })

  it('honors persisted waiting_for_input when run paused for plan approval', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: true,
      waiting_for_input_type: 'plan',
      last_run_status: 'completed',
      last_run_execution_mode: 'plan',
    }
    const storeState = createBaseStoreState()

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(true)
    expect(card.status).toBe('waiting')
  })

  it('honors persisted waiting_for_input when completed run paused on a question', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'completed',
      last_run_execution_mode: 'build',
    }
    const storeState = createBaseStoreState()

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(true)
    expect(card.hasQuestion).toBe(true)
    expect(card.status).toBe('waiting')
  })

  it('clears waiting once a completed question run is answered', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: false,
      waiting_for_input_type: 'question',
      last_run_status: 'completed',
      last_run_execution_mode: 'build',
    }
    const storeState = createBaseStoreState()

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(false)
    expect(card.status).not.toBe('waiting')
  })

  it('recovers legacy completed plan sessions that have a pending plan id but stale review flags', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: false,
      waiting_for_input_type: 'plan',
      is_reviewing: true,
      pending_plan_message_id: 'plan-message-1',
      last_run_status: 'completed',
      last_run_execution_mode: 'plan',
    }
    const storeState = createBaseStoreState({
      reviewingSessions: { 'session-1': true },
    })

    const card = computeSessionCardData(session, storeState)

    expect(getEffectiveSessionWaiting(session, storeState)).toBe(true)
    expect(card.isWaiting).toBe(true)
    expect(card.status).toBe('waiting')
  })

  it('honors persisted waiting_for_input while run still active', () => {
    const session: Session = {
      ...createBaseSession(),
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'running',
      last_run_execution_mode: 'plan',
    }
    const storeState = createBaseStoreState()

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(true)
    expect(card.status).toBe('waiting')
  })
})
