import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockInvoke, mockToast } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('sonner', () => ({
  toast: mockToast,
}))

import { QueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { chatQueryKeys } from '@/services/chat'
import type { WorktreeSessions } from '@/types/chat'
import {
  archiveOriginalPlanSession,
  clearPlanApprovalTransientState,
} from './plan-approval-state'

describe('clearPlanApprovalTransientState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      activeToolCalls: {},
      streamingContentBlocks: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      pendingPlanMessageIds: {},
    })
  })

  it('clears preserved Codex plan tool state before execution tools stream', () => {
    const sessionId = 'session-codex-plan'
    const store = useChatStore.getState()

    store.addToolCall(sessionId, {
      id: 'plan-tool',
      name: 'CodexPlan',
      input: { plan: 'Plan:\n- fix bug' },
    })
    store.addToolBlock(sessionId, 'plan-tool')
    store.setSessionReviewing(sessionId, true)
    store.setWaitingForInput(sessionId, true)
    store.setPendingPlanMessageId(sessionId, 'plan-message')

    clearPlanApprovalTransientState(sessionId)

    const next = useChatStore.getState()
    expect(next.activeToolCalls[sessionId]).toBeUndefined()
    expect(next.streamingContentBlocks[sessionId]).toBeUndefined()
    expect(next.reviewingSessions[sessionId]).toBeUndefined()
    expect(next.waitingForInputSessionIds[sessionId]).toBeUndefined()
    expect(next.pendingPlanMessageIds[sessionId]).toBeUndefined()
    expect(next.getPendingPlanMessageId(sessionId)).toBeNull()
  })
})

describe('archiveOriginalPlanSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function seedSessions(queryClient: QueryClient) {
    queryClient.setQueryData<WorktreeSessions>(chatQueryKeys.sessions('wt'), {
      worktree_id: 'wt',
      sessions: [{ id: 'plan' }, { id: 'exec' }],
      active_session_id: 'plan',
    } as unknown as WorktreeSessions)
  }

  it('archives (never deletes) the planning session so history survives (#795)', async () => {
    const queryClient = new QueryClient()
    seedSessions(queryClient)

    archiveOriginalPlanSession({
      queryClient,
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      sessionId: 'plan',
      replacementSessionId: 'exec',
    })

    expect(mockInvoke).toHaveBeenCalledWith('archive_session', {
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      sessionId: 'plan',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'close_session',
      expect.anything()
    )
    const data = queryClient.getQueryData<WorktreeSessions>(
      chatQueryKeys.sessions('wt')
    )
    expect(data?.sessions.map(s => s.id)).toEqual(['exec'])
    expect(data?.active_session_id).toBe('exec')
  })

  it('offers a Restore action that unarchives the planning session', async () => {
    const queryClient = new QueryClient()
    seedSessions(queryClient)

    archiveOriginalPlanSession({
      queryClient,
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      sessionId: 'plan',
    })

    await vi.waitFor(() => expect(mockToast).toHaveBeenCalled())
    const [message, options] = mockToast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ]
    expect(message).toBe('Planning session archived')
    expect(options.action.label).toBe('Restore')

    options.action.onClick()

    expect(mockInvoke).toHaveBeenCalledWith('unarchive_session', {
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      sessionId: 'plan',
    })
    await vi.waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('Session restored')
    )
  })

  it('does not offer Restore when archiving fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'))
    const queryClient = new QueryClient()
    seedSessions(queryClient)

    archiveOriginalPlanSession({
      queryClient,
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      sessionId: 'plan',
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('keeps the active session when no replacement is in the same worktree', () => {
    const queryClient = new QueryClient()
    seedSessions(queryClient)

    archiveOriginalPlanSession({
      queryClient,
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      sessionId: 'plan',
    })

    const data = queryClient.getQueryData<WorktreeSessions>(
      chatQueryKeys.sessions('wt')
    )
    expect(data?.sessions.map(s => s.id)).toEqual(['exec'])
    expect(data?.active_session_id).toBe('plan')
  })
})
