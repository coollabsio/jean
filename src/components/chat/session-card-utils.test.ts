import { describe, expect, it } from 'vitest'
import {
  buildNativeClientSessionInput,
  computeSessionCardData,
  createSessionCardDataCache,
  getEffectiveSessionWaiting,
  getResumeArgs,
  getResumeCommand,
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

  it('prefers a Jean-managed absolute path over bare grok when provided', () => {
    const grokSession: Session = {
      ...session,
      name: 'Browser test setup check',
      backend: 'grok',
      codex_thread_id: undefined,
      grok_session_id: 'grok-acp-2',
    }
    const managed =
      '/home/user/.local/share/com.jean.desktop/grok-cli/node_modules/.bin/grok'

    expect(getResumeArgs(grokSession, { resolvedCommand: managed })).toEqual({
      command: managed,
      args: ['--resume', 'grok-acp-2'],
    })
    expect(
      buildNativeClientSessionInput(
        grokSession,
        'worktree-1',
        '/tmp/worktree-1',
        { resolvedCommand: managed }
      )
    ).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      name: 'Browser test setup check (Native)',
      backend: 'grok',
      primarySurface: 'terminal',
      terminalCommand: managed,
      terminalCommandArgs: ['--resume', 'grok-acp-2'],
      terminalLabel: 'Browser test setup check (Native)',
      nativeSessionId: 'grok-acp-2',
    })
  })

  it('keeps an already-absolute terminal_command over a resolved path', () => {
    const pathSession: Session = {
      ...session,
      backend: 'codex',
      codex_thread_id: 'thread-abs',
      terminal_command: '/usr/local/bin/codex',
    }
    expect(
      getResumeArgs(pathSession, {
        resolvedCommand:
          '/home/user/.local/share/com.jean.desktop/codex-cli/node_modules/.bin/codex',
      })
    ).toEqual({
      command: '/usr/local/bin/codex',
      args: ['resume', 'thread-abs'],
    })
  })

  it('builds an Antigravity resume launch with --conversation', () => {
    const antigravitySession: Session = {
      ...session,
      name: 'Antigravity conversation support',
      backend: 'antigravity',
      codex_thread_id: undefined,
      antigravity_session_id: 'agy-conv-1',
    }

    expect(getResumeArgs(antigravitySession)).toEqual({
      command: 'agy',
      args: ['--conversation', 'agy-conv-1'],
    })
    expect(
      buildNativeClientSessionInput(
        antigravitySession,
        'worktree-1',
        '/tmp/worktree-1'
      )
    ).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      name: 'Antigravity conversation support (Native)',
      backend: 'antigravity',
      primarySurface: 'terminal',
      terminalCommand: 'agy',
      terminalCommandArgs: ['--conversation', 'agy-conv-1'],
      terminalLabel: 'Antigravity conversation support (Native)',
      nativeSessionId: 'agy-conv-1',
    })
  })

  it('builds a Muse resume launch with the resume subcommand', () => {
    const museSession: Session = {
      ...session,
      name: 'Muse session support',
      backend: 'muse',
      codex_thread_id: undefined,
      muse_session_id: 'muse-sess-1',
    }

    expect(getResumeCommand(museSession)).toBe('muse resume muse-sess-1')
    expect(getResumeArgs(museSession)).toEqual({
      command: 'muse',
      args: ['resume', 'muse-sess-1'],
    })
    expect(
      getResumeArgs(museSession, {
        resolvedCommand: '/home/user/.local/bin/muse',
      })
    ).toEqual({
      command: '/home/user/.local/bin/muse',
      args: ['resume', 'muse-sess-1'],
    })
    expect(
      buildNativeClientSessionInput(
        museSession,
        'worktree-1',
        '/tmp/worktree-1'
      )
    ).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      name: 'Muse session support (Native)',
      backend: 'muse',
      primarySurface: 'terminal',
      terminalCommand: 'muse',
      terminalCommandArgs: ['resume', 'muse-sess-1'],
      terminalLabel: 'Muse session support (Native)',
      nativeSessionId: 'muse-sess-1',
    })
  })

  it('returns no Muse resume launch before the session id is known', () => {
    const museSession: Session = {
      ...session,
      backend: 'muse',
      codex_thread_id: undefined,
      muse_session_id: null,
    }

    expect(getResumeCommand(museSession)).toBeNull()
    expect(getResumeArgs(museSession)).toBeNull()
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
      sessionStatusOverrides: {},
      pendingPermissionDenials: {},
      pendingCodexPermissionRequests: {},
      pendingOpencodePermissionRequests: {},
      pendingCodexCommandApprovalRequests: {},
      pendingCodexUserInputRequests: {},
      pendingCodexMcpElicitationRequests: {},
      pendingCodexDynamicToolCallRequests: {},
      sessionLabels: {},
      ...overrides,
    }
  }

  it.each(['supervised', 'auto'] as const)(
    'shows %s turns as running Build work',
    mode => {
      const session = createBaseSession({ selected_execution_mode: mode })
      const state = createBaseStoreState({
        sendingSessionIds: { 'session-1': true },
        executionModes: { 'session-1': mode },
      })
      expect(computeSessionCardData(session, state).status).toBe('vibing')
      const restored = createBaseSession({
        last_run_status: 'running',
        last_run_execution_mode: mode,
      })
      expect(
        computeSessionCardData(restored, createBaseStoreState()).status
      ).toBe('vibing')
    }
  )

  it('reuses a card when unrelated session state changes', () => {
    const session = createBaseSession()
    const cache = createSessionCardDataCache()
    const storeState = createBaseStoreState()

    const first = cache(session, storeState)
    const unchanged = cache(session, {
      ...storeState,
      sendingSessionIds: { 'other-session': true },
    })

    expect(unchanged).toBe(first)
  })

  it('recomputes a card when its session state changes', () => {
    const session = createBaseSession()
    const cache = createSessionCardDataCache()
    const storeState = createBaseStoreState()

    const first = cache(session, storeState)
    const changed = cache(session, {
      ...storeState,
      sendingSessionIds: { [session.id]: true },
    })

    expect(changed).not.toBe(first)
    expect(changed.isSending).toBe(true)
  })

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
    expect(card.status).toBe('plan_approval')
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
      sessionStatusOverrides: { 'session-1': 'review' },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('review')
    expect(card.statusOverride).toBe('review')
    expect(card.automaticStatus).toBe('review')
  })

  it('applies a manual status override when automatic status is terminal', () => {
    const session = createBaseSession({
      last_run_status: 'completed',
      last_run_execution_mode: 'build',
    })
    const storeState = createBaseStoreState({
      sessionStatusOverrides: { 'session-1': 'cancelled' },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.automaticStatus).toBe('completed')
    expect(card.statusOverride).toBe('cancelled')
    expect(card.status).toBe('cancelled')
  })

  it('does not let a manual override hide waiting status during an active run', () => {
    const session = createBaseSession({
      backend: 'codex',
      last_run_status: 'running',
      last_run_execution_mode: 'build',
    })
    const storeState = createBaseStoreState({
      sendingSessionIds: { 'session-1': true },
      sessionStatusOverrides: { 'session-1': 'review' },
      pendingCodexCommandApprovalRequests: {
        'session-1': [{ rpc_id: 1 } as never],
      },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.automaticStatus).toBe('command_approval')
    expect(card.statusOverride).toBe('review')
    expect(card.status).toBe('command_approval')
  })

  it('lets an explicit override replace persisted waiting status when idle', () => {
    const session = createBaseSession({
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'completed',
      last_run_execution_mode: 'plan',
    })
    const storeState = createBaseStoreState({
      sessionStatusOverrides: { 'session-1': 'completed' },
      waitingForInputSessionIds: { 'session-1': true },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.automaticStatus).toBe('input_required')
    expect(card.statusOverride).toBe('completed')
    expect(card.status).toBe('completed')
  })

  it('keeps persisted waiting status over a review override', () => {
    const session = createBaseSession({
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'completed',
      last_run_execution_mode: 'plan',
    })
    const storeState = createBaseStoreState({
      sessionStatusOverrides: { 'session-1': 'review' },
      waitingForInputSessionIds: { 'session-1': true },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.automaticStatus).toBe('input_required')
    expect(card.status).toBe('input_required')
  })

  it('lets a manual override replace stale permission denials after a run', () => {
    const session = createBaseSession({
      backend: 'claude',
      last_run_status: 'completed',
      last_run_execution_mode: 'yolo',
      selected_execution_mode: 'yolo',
      status_override: 'completed',
      pending_permission_denials: [
        { tool_name: 'WebSearch', tool_use_id: 'toolu_1', tool_input: {} },
      ],
    })
    const storeState = createBaseStoreState({
      executionModes: { 'session-1': 'build' },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.automaticStatus).toBe('permission')
    expect(card.statusOverride).toBe('completed')
    expect(card.status).toBe('completed')
  })

  it('can force idle even when automatic status is completed', () => {
    const session = createBaseSession({
      last_run_status: 'completed',
    })
    const storeState = createBaseStoreState({
      sessionStatusOverrides: { 'session-1': 'idle' },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.automaticStatus).toBe('completed')
    expect(card.status).toBe('idle')
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
    })
  })

  it('shows a code review tab as loading while its review job is running', () => {
    const session = createBaseSession({
      name: 'Code Review · Codex · gpt-5.6-sol',
      is_reviewing: true,
      review_results: {
        reviews: [
          { backend: 'codex', model: 'gpt-5.6-sol', status: 'running' },
        ],
      },
    })

    const card = computeSessionCardData(
      session,
      createBaseStoreState({ reviewingSessions: { [session.id]: true } })
    )

    expect(card.status).toBe('reviewing')
  })

  it('shows a code review tab as review ready when its review job completed', () => {
    const session = createBaseSession({
      name: 'Code Review · Codex · gpt-5.6-sol',
      is_reviewing: false,
      review_results: {
        reviews: [
          { backend: 'codex', model: 'gpt-5.6-sol', status: 'completed' },
        ],
      },
    })

    const card = computeSessionCardData(session, createBaseStoreState())

    expect(card.status).toBe('review')
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
    expect(card.status).toBe('plan_approval')
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
    expect(card.status).toBe('input_required')
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
    expect(card.status).toBe('plan_approval')
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
    expect(card.status).toBe('input_required')
  })

  it('ignores stale persisted waiting state after a Claude turn starts sending', () => {
    const session: Session = {
      ...createBaseSession(),
      backend: 'claude',
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'running',
      last_run_execution_mode: 'yolo',
    }
    const storeState = createBaseStoreState({
      sendingSessionIds: { 'session-1': true },
      executingModes: { 'session-1': 'yolo' },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('yoloing')
  })

  it('does not show a stale Claude question while a later turn is running', () => {
    const session: Session = {
      ...createBaseSession(),
      backend: 'claude',
      last_run_status: 'running',
      last_run_execution_mode: 'yolo',
    }
    const storeState = createBaseStoreState({
      sendingSessionIds: { 'session-1': true },
      executingModes: { 'session-1': 'yolo' },
      activeToolCalls: {
        'session-1': [
          { id: 'old-question', name: 'AskUserQuestion', input: {} },
        ],
      },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('yoloing')
  })

  describe('pending question from persisted messages', () => {
    const questionMessage = {
      id: 'assistant-1',
      session_id: 'session-1',
      role: 'assistant' as const,
      content: 'Which option?',
      timestamp: 1,
      tool_calls: [
        {
          id: 'question-1',
          name: 'AskUserQuestion',
          input: { questions: [] },
        },
      ],
    }

    it('treats an unanswered AskUserQuestion in the last assistant message as pending', () => {
      const session = createBaseSession({ messages: [questionMessage] })

      const card = computeSessionCardData(session, createBaseStoreState())

      expect(card.hasQuestion).toBe(true)
      expect(card.isWaiting).toBe(true)
    })

    it('does not treat a question as pending when a user message follows it (#779)', () => {
      const session = createBaseSession({
        messages: [
          questionMessage,
          {
            id: 'user-1',
            session_id: 'session-1',
            role: 'user',
            content: 'My answer',
            timestamp: 2,
            tool_calls: [],
          },
        ],
      })

      const card = computeSessionCardData(session, createBaseStoreState())

      expect(card.hasQuestion).toBe(false)
      expect(card.isWaiting).toBe(false)
    })

    it('still treats it as pending when the user message came before the question', () => {
      const session = createBaseSession({
        messages: [
          {
            id: 'user-1',
            session_id: 'session-1',
            role: 'user',
            content: 'Do the thing',
            timestamp: 0,
            tool_calls: [],
          },
          questionMessage,
        ],
      })

      const card = computeSessionCardData(session, createBaseStoreState())

      expect(card.hasQuestion).toBe(true)
    })
  })

  it('shows a running Claude turn instead of a hidden old permission denial', () => {
    const denial = {
      tool_name: 'Bash',
      tool_use_id: 'old-denial',
      tool_input: {},
    }
    const session = createBaseSession({
      backend: 'claude',
      last_run_status: 'running',
      last_run_execution_mode: 'yolo',
      pending_permission_denials: [denial],
    })
    const storeState = createBaseStoreState({
      sendingSessionIds: { 'session-1': true },
      executingModes: { 'session-1': 'yolo' },
      pendingPermissionDenials: { 'session-1': [denial] },
    })

    const card = computeSessionCardData(session, storeState)

    expect(card.hasPermissionDenials).toBe(false)
    expect(card.isWaiting).toBe(false)
    expect(card.status).toBe('yoloing')
  })

  it('does not show a hidden permission denial after a yolo turn completes', () => {
    const session = createBaseSession({
      backend: 'claude',
      last_run_status: 'completed',
      selected_execution_mode: 'yolo',
      pending_permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'old-denial', tool_input: {} },
      ],
    })

    const card = computeSessionCardData(session, createBaseStoreState())

    expect(card.hasPermissionDenials).toBe(false)
    expect(card.status).toBe('completed')
  })

  it('maps cancelled last_run_status to cancelled (not idle)', () => {
    const session = createBaseSession({ last_run_status: 'cancelled' })
    const card = computeSessionCardData(session, createBaseStoreState())
    expect(card.status).toBe('cancelled')
    expect(statusConfig[card.status].label).toBe('Cancelled')
  })

  it('maps crashed last_run_status to crashed (not idle)', () => {
    const session = createBaseSession({ last_run_status: 'crashed' })
    const card = computeSessionCardData(session, createBaseStoreState())
    expect(card.status).toBe('crashed')
    expect(statusConfig[card.status].label).toBe('Crashed')
  })

  it('maps pending Claude permission denials to permission', () => {
    const session = createBaseSession({
      pending_permission_denials: [
        {
          tool_name: 'Bash',
          tool_use_id: 'tu-1',
          tool_input: {},
        } as never,
      ],
    })
    const card = computeSessionCardData(session, createBaseStoreState())
    expect(card.status).toBe('permission')
    expect(card.hasPermissionDenials).toBe(true)
  })

  it('maps Codex pending queues to specific actionable statuses', () => {
    const base = createBaseSession({ last_run_status: 'running' })

    expect(
      computeSessionCardData(
        {
          ...base,
          pending_codex_command_approval_requests: [
            { rpc_id: 1, item_id: 'i', thread_id: 't', turn_id: 'u' },
          ],
        },
        createBaseStoreState()
      ).status
    ).toBe('command_approval')

    expect(
      computeSessionCardData(
        {
          ...base,
          pending_codex_user_input_requests: [
            { rpc_id: 1, item_id: 'i' } as never,
          ],
        },
        createBaseStoreState()
      ).status
    ).toBe('input_required')

    expect(
      computeSessionCardData(
        {
          ...base,
          pending_codex_mcp_elicitation_requests: [
            { rpc_id: 1, item_id: 'i' } as never,
          ],
        },
        createBaseStoreState()
      ).status
    ).toBe('mcp_input')

    expect(
      computeSessionCardData(
        {
          ...base,
          pending_codex_dynamic_tool_call_requests: [
            { rpc_id: 1, item_id: 'i' } as never,
          ],
        },
        createBaseStoreState()
      ).status
    ).toBe('tool_approval')

    expect(
      computeSessionCardData(
        {
          ...base,
          pending_codex_permission_requests: [
            {
              rpc_id: 1,
              item_id: 'i',
              permissions: {},
            },
          ],
        },
        createBaseStoreState()
      ).status
    ).toBe('permission')
  })

  it('maps scheduled_wakeup to scheduled when otherwise idle', () => {
    const session = createBaseSession({
      last_run_status: 'completed',
      scheduled_wakeup: {
        fire_at_unix: Date.now() / 1000 + 60,
        scheduled_at_unix: Date.now() / 1000,
        delay_seconds: 60,
        prompt: 'continue',
        reason: 'wait',
        tool_call_id: 'tc-1',
      },
    })
    // completed normally wins over scheduled when last_run is completed
    // and no waiting — but scheduled is checked before completed
    const card = computeSessionCardData(session, createBaseStoreState())
    expect(card.status).toBe('scheduled')
  })

  it('keeps review and completed distinguishable', () => {
    const reviewCard = computeSessionCardData(
      createBaseSession({
        is_reviewing: true,
        last_run_status: 'completed',
      }),
      createBaseStoreState({ reviewingSessions: { 'session-1': true } })
    )
    const completedCard = computeSessionCardData(
      createBaseSession({ last_run_status: 'completed' }),
      createBaseStoreState()
    )
    expect(reviewCard.status).toBe('review')
    expect(completedCard.status).toBe('completed')
    expect(statusConfig[reviewCard.status].label).toBe('Review ready')
    expect(statusConfig[completedCard.status].label).toBe('Completed')
  })

  it('prefers input_required over plan_approval when both are waiting', () => {
    const session = createBaseSession({
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'completed',
      pending_plan_message_id: 'plan-msg',
    })
    // hasExitPlanMode from pending plan id inference only when type is plan;
    // force both flags via messages
    const withMessages: Session = {
      ...session,
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          role: 'assistant',
          content: 'Choose and plan',
          timestamp: 1,
          tool_calls: [
            {
              id: 'q1',
              name: 'AskUserQuestion',
              input: { questions: [] },
            },
            {
              id: 'p1',
              name: 'ExitPlanMode',
              input: {},
            },
          ],
        },
      ],
    }
    const card = computeSessionCardData(withMessages, createBaseStoreState())
    expect(card.hasQuestion).toBe(true)
    expect(card.hasExitPlanMode).toBe(true)
    expect(card.status).toBe('input_required')
  })
})
