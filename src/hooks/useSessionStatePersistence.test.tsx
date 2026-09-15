import { createElement, type PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStatePersistence } from './useSessionStatePersistence'
import { useChatStore } from '@/store/chat-store'
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
    useChatStore.setState({
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
