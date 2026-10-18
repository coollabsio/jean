import { createElement, type PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStatePersistence } from './useSessionStatePersistence'
import { useChatStore } from '@/store/chat-store'
import { isSessionStateHydrating } from '@/lib/session-state-hydration'
import type { WorktreeSessions } from '@/types/chat'
import type { ReviewResponse } from '@/types/projects'

const { mockUseSessions, mockUpdateSessionState } = vi.hoisted(() => ({
  mockUseSessions: vi.fn(),
  mockUpdateSessionState: vi.fn(),
}))

vi.mock('@/services/chat', () => ({
  useSessions: mockUseSessions,
  useUpdateSessionState: () => ({ mutate: mockUpdateSessionState }),
  chatQueryKeys: {
    session: (sessionId: string) => ['session', sessionId],
    sessions: (worktreeId: string) => ['sessions', worktreeId],
  },
}))

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('useSessionStatePersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateSessionState.mockReset()
    useChatStore.setState({
      executionModes: {},
      permissionModes: {},
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/repo',
      activeSessionIds: { 'worktree-1': 'session-1' },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/repo' },
      waitingForInputSessionIds: { 'session-1': true },
      reviewingSessions: {},
      reviewResults: {},
      fixedFindings: {},
      fixedReviewFindings: {},
      pendingPlanMessageIds: { 'session-1': 'plan-message-1' },
    })
  })

  it('saves and restores Build permissions without leaving Plan', async () => {
    const data: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Permissions',
          order: 0,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'codex',
          selected_execution_mode: 'plan',
          selected_permission_mode: 'auto',
        },
      ],
    }
    const persistedSession = data.sessions[0]
    if (!persistedSession) throw new Error('Missing test session')
    mockUseSessions.mockReturnValue({ data })
    mockUpdateSessionState.mockImplementation(update => {
      if (update.selectedPermissionMode)
        persistedSession.selected_permission_mode =
          update.selectedPermissionMode
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = createWrapper(queryClient)
    const first = renderHook(() => useSessionStatePersistence(), { wrapper })
    await waitFor(() =>
      expect(useChatStore.getState().permissionModes['session-1']).toBe('auto')
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120))
    })
    act(() =>
      useChatStore.getState().setPermissionMode('session-1', 'supervised')
    )
    await waitFor(() =>
      expect(persistedSession.selected_permission_mode).toBe('supervised')
    )
    expect(useChatStore.getState().getExecutionMode('session-1')).toBe('plan')
    first.unmount()
    act(() =>
      useChatStore.setState({ executionModes: {}, permissionModes: {} })
    )
    const second = renderHook(() => useSessionStatePersistence(), { wrapper })
    await waitFor(() =>
      expect(useChatStore.getState().permissionModes['session-1']).toBe(
        'supervised'
      )
    )
    expect(useChatStore.getState().getExecutionMode('session-1')).toBe('plan')
    second.unmount()
  })

  it('hydrates persisted queued messages after a WebSocket reconnect', async () => {
    const queuedMessage = {
      id: 'queue-1',
      message: 'queued prompt',
      pendingImages: [],
      pendingFiles: [],
      pendingSkills: [],
      pendingTextFiles: [],
      model: 'claude-sonnet-4-5',
      provider: null,
      executionMode: 'plan' as const,
      thinkingLevel: 'off' as const,
      queuedAt: 123,
    }
    const sessionsData: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Reconnected session',
          order: 0,
          created_at: 1,
          updated_at: 2,
          messages: [],
          backend: 'claude',
          queued_messages: [queuedMessage],
        },
      ],
    }
    mockUseSessions.mockReturnValue({ data: sessionsData })
    useChatStore.setState({ messageQueues: {} })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const wrapper = createWrapper(queryClient)

    renderHook(() => useSessionStatePersistence(), { wrapper })

    await waitFor(() => {
      expect(useChatStore.getState().messageQueues['session-1']).toEqual([
        queuedMessage,
      ])
    })
  })

  it('merges stale on-disk answered questions with in-memory answers on load (#779)', async () => {
    const sessionsData: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Question session',
          order: 0,
          created_at: 1,
          updated_at: 2,
          messages: [],
          backend: 'claude',
          answered_questions: ['disk-question'],
          submitted_answers: {
            'disk-question': [{ questionIndex: 0, selectedOptions: [0] }],
            'shared-question': [{ questionIndex: 0, selectedOptions: [0] }],
          },
        },
      ],
    }
    mockUseSessions.mockReturnValue({ data: sessionsData })
    useChatStore.setState({
      answeredQuestions: { 'session-1': new Set(['memory-question']) },
      submittedAnswers: {
        'session-1': {
          'memory-question': [{ questionIndex: 0, selectedOptions: [1] }],
          'shared-question': [{ questionIndex: 0, selectedOptions: [1] }],
        },
      },
    })

    const hydratingDuringAnsweredUpdate: boolean[] = []
    const unsubscribe = useChatStore.subscribe((state, prev) => {
      if (state.answeredQuestions !== prev.answeredQuestions) {
        hydratingDuringAnsweredUpdate.push(isSessionStateHydrating())
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const wrapper = createWrapper(queryClient)

    try {
      renderHook(() => useSessionStatePersistence(), { wrapper })

      await waitFor(() => {
        expect(
          useChatStore
            .getState()
            .answeredQuestions['session-1']?.has('disk-question')
        ).toBe(true)
      })
    } finally {
      unsubscribe()
    }

    const state = useChatStore.getState()
    expect(state.answeredQuestions['session-1']).toEqual(
      new Set(['disk-question', 'memory-question'])
    )
    expect(state.submittedAnswers['session-1']).toEqual({
      'disk-question': [{ questionIndex: 0, selectedOptions: [0] }],
      'memory-question': [{ questionIndex: 0, selectedOptions: [1] }],
      // In-memory answer wins over the on-disk one
      'shared-question': [{ questionIndex: 0, selectedOptions: [1] }],
    })
    // Applied inside the hydration guard so it is not written straight back
    expect(hydratingDuringAnsweredUpdate).toEqual([true])
    expect(isSessionStateHydrating()).toBe(false)
  })

  it('keeps in-memory answered questions when disk has no new ids', async () => {
    const sessionsData: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Question session',
          order: 0,
          created_at: 1,
          updated_at: 2,
          messages: [],
          backend: 'claude',
          answered_questions: ['question-1'],
        },
      ],
    }
    mockUseSessions.mockReturnValue({ data: sessionsData })
    const inMemory = new Set(['question-1', 'question-2'])
    useChatStore.setState({
      answeredQuestions: { 'session-1': inMemory },
      submittedAnswers: {},
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const wrapper = createWrapper(queryClient)

    renderHook(() => useSessionStatePersistence(), { wrapper })

    await new Promise(resolve => setTimeout(resolve, 50))

    // Stale disk list must not drop question-2 (no replacement at all)
    expect(useChatStore.getState().answeredQuestions['session-1']).toBe(
      inMemory
    )
  })

  it('does not change a selected plan-waiting Codex session to review', async () => {
    const sessionsData: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Waiting plan',
          order: 0,
          created_at: 1,
          updated_at: 2,
          messages: [],
          backend: 'codex',
          waiting_for_input: true,
          waiting_for_input_type: 'plan',
          pending_plan_message_id: 'plan-message-1',
          is_reviewing: false,
          last_run_status: 'completed',
          last_run_execution_mode: 'plan',
        },
      ],
    }
    mockUseSessions.mockReturnValue({ data: sessionsData })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const wrapper = createWrapper(queryClient)

    renderHook(() => useSessionStatePersistence(), { wrapper })

    await waitFor(() => {
      const state = useChatStore.getState()
      expect(state.waitingForInputSessionIds['session-1']).toBe(true)
      expect(state.reviewingSessions['session-1']).toBeUndefined()
    })
    expect(mockUpdateSessionState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        isReviewing: true,
        waitingForInput: false,
      })
    )
  })

  it('persists fixed review findings marked from the review panel', async () => {
    const sessionsData: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Code Review',
          order: 0,
          created_at: 1,
          updated_at: 2,
          messages: [],
          backend: 'claude',
          is_reviewing: false,
          review_results: {
            summary: 'One issue found.',
            approval_status: 'changes_requested',
            findings: [],
          },
        },
      ],
    }
    mockUseSessions.mockReturnValue({ data: sessionsData })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const wrapper = createWrapper(queryClient)

    renderHook(() => useSessionStatePersistence(), { wrapper })

    await waitFor(() => {
      expect(useChatStore.getState().reviewResults['session-1']).toBeDefined()
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    useChatStore
      .getState()
      .markReviewFindingFixed('session-1', 'src/App.tsx:10:0')

    await waitFor(
      () => {
        expect(mockUpdateSessionState).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'session-1',
            fixedFindings: ['src/App.tsx:10:0'],
          })
        )
      },
      { timeout: 1000 }
    )
  })

  it('hydrates review results when an already-open review session completes', async () => {
    const completedReview: ReviewResponse = {
      summary: 'One issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'Missing null guard',
          description: 'The value can be null here.',
        },
      ],
    }

    let sessionsData: WorktreeSessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      version: 1,
      sessions: [
        {
          id: 'session-1',
          name: 'Code Review',
          order: 0,
          created_at: 1,
          updated_at: 2,
          messages: [],
          backend: 'claude',
          is_reviewing: true,
          last_run_status: 'running',
        },
      ],
    }
    mockUseSessions.mockImplementation(() => ({ data: sessionsData }))

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const wrapper = createWrapper(queryClient)

    const { rerender } = renderHook(() => useSessionStatePersistence(), {
      wrapper,
    })

    await waitFor(() => {
      expect(useChatStore.getState().reviewingSessions['session-1']).toBe(true)
    })
    expect(useChatStore.getState().reviewResults['session-1']).toBeUndefined()

    const reviewSession = sessionsData.sessions[0]
    if (!reviewSession) {
      throw new Error('Expected review session fixture')
    }
    sessionsData = {
      ...sessionsData,
      version: 2,
      sessions: [
        {
          ...reviewSession,
          updated_at: 3,
          is_reviewing: false,
          last_run_status: 'completed',
          review_results: completedReview,
        },
      ],
    }
    rerender()

    await waitFor(() => {
      const state = useChatStore.getState()
      expect(state.reviewingSessions['session-1']).toBe(false)
      expect(state.reviewResults['session-1']).toEqual(completedReview)
    })
  })
})
