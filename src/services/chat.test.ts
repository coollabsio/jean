import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
  hasBackendTransport: () => true,
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import {
  canReconnectSession,
  chatQueryKeys,
  clearQuestionWaitingStateInSessionListCache,
  prefetchSessions,
  reconnectNativeCliSession,
} from './chat'
import { preserveQueryCacheOnError } from '@/lib/query-error'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { toast } from 'sonner'
import { disposeTerminal } from '@/lib/terminal-instances'
import type { Session, WorktreeSessions } from '@/types/chat'

const toastMock = toast as unknown as {
  success: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

describe('question waiting session cache', () => {
  it('clears only the target session and preserves the cache on repeated clears', () => {
    const queryClient = new QueryClient()
    const waitingSession: Session = {
      id: 'session-1',
      name: 'Waiting',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
      waiting_for_input: true,
      waiting_for_input_type: 'question',
    }
    const otherSession: Session = {
      ...waitingSession,
      id: 'session-2',
      name: 'Other',
    }
    const sessions: WorktreeSessions = {
      worktree_id: 'wt-1',
      sessions: [waitingSession, otherSession],
      active_session_id: 'session-1',
      version: 2,
    }
    const withCountsSession: Session = {
      ...waitingSession,
      message_count: 3,
    }
    const sessionsWithCounts: WorktreeSessions = {
      ...sessions,
      sessions: [withCountsSession, { ...otherSession, message_count: 1 }],
    }
    queryClient.setQueryData(chatQueryKeys.sessions('wt-1'), sessions)
    queryClient.setQueryData(
      [...chatQueryKeys.sessions('wt-1'), 'with-counts'],
      sessionsWithCounts
    )

    clearQuestionWaitingStateInSessionListCache(
      queryClient,
      'wt-1',
      'session-1'
    )

    const updated = queryClient.getQueryData<WorktreeSessions>(
      chatQueryKeys.sessions('wt-1')
    )
    expect(updated?.sessions[0]).toMatchObject({
      waiting_for_input: false,
      waiting_for_input_type: undefined,
    })
    expect(updated?.sessions[1]).toBe(otherSession)
    const updatedWithCounts = queryClient.getQueryData<WorktreeSessions>([
      ...chatQueryKeys.sessions('wt-1'),
      'with-counts',
    ])
    expect(updatedWithCounts?.sessions[0]).toMatchObject({
      waiting_for_input: false,
      waiting_for_input_type: undefined,
      message_count: 3,
    })
    expect(updatedWithCounts?.sessions[1]).toBe(sessionsWithCounts.sessions[1])

    clearQuestionWaitingStateInSessionListCache(
      queryClient,
      'wt-1',
      'session-1'
    )
    expect(queryClient.getQueryData(chatQueryKeys.sessions('wt-1'))).toBe(
      updated
    )
    expect(
      queryClient.getQueryData([
        ...chatQueryKeys.sessions('wt-1'),
        'with-counts',
      ])
    ).toBe(updatedWithCounts)
  })

  it('clears a legacy typeless question wait', () => {
    const queryClient = new QueryClient()
    const legacySession: Session = {
      id: 'session-1',
      name: 'Legacy question',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
      waiting_for_input: true,
    }
    queryClient.setQueryData<WorktreeSessions>(chatQueryKeys.sessions('wt-1'), {
      worktree_id: 'wt-1',
      sessions: [legacySession],
      active_session_id: 'session-1',
      version: 2,
    })

    clearQuestionWaitingStateInSessionListCache(
      queryClient,
      'wt-1',
      'session-1'
    )

    expect(
      queryClient.getQueryData<WorktreeSessions>(chatQueryKeys.sessions('wt-1'))
        ?.sessions[0]
    ).toMatchObject({ waiting_for_input: false })
  })

  it.each([
    [
      'plan',
      {
        waiting_for_input: true,
        waiting_for_input_type: 'plan' as const,
      },
    ],
    [
      'legacy plan',
      {
        waiting_for_input: true,
        pending_plan_message_id: 'plan-message-1',
      },
    ],
    [
      'permission',
      {
        waiting_for_input: true,
        waiting_for_input_type: 'question' as const,
        pending_permission_denials: [
          {
            tool_name: 'Bash',
            tool_use_id: 'tool-1',
            tool_input: { command: 'echo test' },
          },
        ],
      },
    ],
  ])('does not clear a %s wait', (_kind, waitingState) => {
    const queryClient = new QueryClient()
    const session: Session = {
      id: 'session-1',
      name: 'Other wait',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
      ...waitingState,
    }
    const sessions: WorktreeSessions = {
      worktree_id: 'wt-1',
      sessions: [session],
      active_session_id: 'session-1',
      version: 2,
    }
    queryClient.setQueryData(chatQueryKeys.sessions('wt-1'), sessions)

    clearQuestionWaitingStateInSessionListCache(
      queryClient,
      'wt-1',
      'session-1'
    )

    expect(queryClient.getQueryData(chatQueryKeys.sessions('wt-1'))).toBe(
      sessions
    )
  })
})

describe('transient WebSocket query failures', () => {
  it('rethrows disconnects so TanStack Query preserves cached session data', () => {
    const error = new Error('WebSocket disconnected')

    expect(() => preserveQueryCacheOnError(error)).toThrow(error)
  })

  it('does not convert other load failures into empty session data', () => {
    const error = new Error('session file is invalid')

    expect(() => preserveQueryCacheOnError(error)).toThrow(error)
  })
})

describe('prefetchSessions', () => {
  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).__JEAN_E2E_MOCK__ = true
    useChatStore.setState({
      sessionWorktreeMap: {},
      worktreePaths: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      executionModes: {},
      sessionLabels: {},
      reviewResults: {},
      answeredQuestions: {},
      submittedAnswers: {},
      fixedReviewFindings: {},
    })
  })

  it('hydrates answered question state and submitted answers from prefetched sessions', async () => {
    const { invoke } = await import('@/lib/transport')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      worktree_id: 'wt-1',
      sessions: [
        {
          id: 'session-1',
          name: 'Session 1',
          order: 0,
          created_at: 1,
          updated_at: 1,
          messages: [],
          version: 2,
          answered_questions: ['tool-1'],
          submitted_answers: {
            'tool-1': [{ questionIndex: 0, selectedOptions: [1] }],
          },
          fixed_findings: [],
          waiting_for_input: false,
        },
      ],
      active_session_id: 'session-1',
      version: 2,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    await prefetchSessions(queryClient, 'wt-1', '/tmp/wt-1')

    const state = useChatStore.getState()
    expect(state.sessionWorktreeMap['session-1']).toBe('wt-1')
    expect(state.answeredQuestions['session-1']?.has('tool-1')).toBe(true)
    expect(state.submittedAnswers['session-1']).toEqual({
      'tool-1': [{ questionIndex: 0, selectedOptions: [1] }],
    })
  })
})

describe('reconnectNativeCliSession', () => {
  const terminalSession: Session = {
    id: 'session-1',
    name: 'Claude',
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    version: 2,
    backend: 'claude',
    claude_session_id: 'abc123',
    primary_surface: 'terminal',
    terminal_command: '/usr/local/bin/claude',
    terminal_label: 'Claude',
  } as Session

  beforeEach(async () => {
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    ;(disposeTerminal as ReturnType<typeof vi.fn>).mockClear()
    ;(disposeTerminal as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const { invoke } = await import('@/lib/transport')
    ;(invoke as ReturnType<typeof vi.fn>).mockClear()
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useUIStore.setState({ sessionPrimarySurface: {}, sessionTerminalIds: {} })
    useTerminalStore.setState({ terminals: {}, modalTerminalOpen: {} })
    // reconnectNativeCliSession calls setActiveSession; isolate the chat-store
    // from the neighbouring describe block.
    useChatStore.setState({ activeSessionIds: {}, sessionWorktreeMap: {} })
  })

  it('relaunches the terminal and restores the terminal surface', async () => {
    await reconnectNativeCliSession(terminalSession, 'wt-1')

    const ui = useUIStore.getState()
    expect(ui.sessionPrimarySurface['session-1']).toBe('terminal')
    const terminalId = ui.sessionTerminalIds['session-1']
    expect(terminalId).toBeDefined()

    const terminal = useTerminalStore
      .getState()
      .terminals['wt-1']?.find(t => t.id === terminalId)
    // Resumes the same Claude conversation via --resume <id>.
    expect(terminal?.command).toBe('/usr/local/bin/claude')
    expect(terminal?.commandArgs).toEqual(['--resume', 'abc123'])
  })

  it('preserves native CLI global flags when resuming', async () => {
    await reconnectNativeCliSession(
      {
        ...terminalSession,
        terminal_command_args: [
          '--permission-mode',
          'bypassPermissions',
          '--session-id',
          'abc123',
        ],
      },
      'wt-1'
    )

    const terminalId = useUIStore.getState().sessionTerminalIds['session-1']
    const terminal = useTerminalStore
      .getState()
      .terminals['wt-1']?.find(t => t.id === terminalId)
    expect(terminal?.commandArgs).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--resume',
      'abc123',
    ])
  })

  it('refuses to reconnect native sessions without a persisted resume ID', () => {
    expect(
      canReconnectSession({
        ...terminalSession,
        claude_session_id: undefined,
        terminal_command_args: ['--permission-mode', 'bypassPermissions'],
      })
    ).toBe(false)
  })

  it('opens the modal drawer and toasts by default (manual reconnect)', async () => {
    await reconnectNativeCliSession(terminalSession, 'wt-1')

    expect(useTerminalStore.getState().modalTerminalOpen['wt-1']).toBe(true)
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it('stays silent and inline when openModal/showToast are false (startup auto-restore)', async () => {
    await reconnectNativeCliSession(terminalSession, 'wt-1', {
      openModal: false,
      showToast: false,
      markOpened: false,
    })

    // Terminal still restored...
    expect(useUIStore.getState().sessionTerminalIds['session-1']).toBeDefined()
    // ...but no floating drawer pops and no toast fires.
    expect(
      useTerminalStore.getState().modalTerminalOpen['wt-1']
    ).toBeUndefined()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('does not mark the session opened when markOpened is false', async () => {
    const { invoke } = await import('@/lib/transport')

    await reconnectNativeCliSession(terminalSession, 'wt-1', {
      openModal: false,
      showToast: false,
      markOpened: false,
    })

    expect(invoke).not.toHaveBeenCalledWith('set_session_last_opened', {
      sessionId: 'session-1',
    })
  })

  it('marks the session opened by default (manual reconnect)', async () => {
    const { invoke } = await import('@/lib/transport')

    await reconnectNativeCliSession(terminalSession, 'wt-1')

    expect(invoke).toHaveBeenCalledWith('set_session_last_opened', {
      sessionId: 'session-1',
    })
  })

  it('continues reconnecting when old terminal disposal fails', async () => {
    useUIStore.setState({
      sessionPrimarySurface: {},
      sessionTerminalIds: { 'session-1': 'old-terminal' },
    })
    useTerminalStore.setState({
      terminals: {
        'wt-1': [
          {
            id: 'old-terminal',
            worktreeId: 'wt-1',
            label: 'Old Terminal',
            command: 'claude',
          },
        ],
      },
      modalTerminalOpen: {},
    })
    ;(disposeTerminal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('already disposed')
    )

    await reconnectNativeCliSession(terminalSession, 'wt-1')

    const terminalId = useUIStore.getState().sessionTerminalIds['session-1']
    expect(terminalId).toBeDefined()
    expect(terminalId).not.toBe('old-terminal')
    expect(
      useTerminalStore
        .getState()
        .terminals['wt-1']?.some(terminal => terminal.id === 'old-terminal')
    ).toBe(false)
  })
})
