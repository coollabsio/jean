import { createElement, type PropsWithChildren } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useStreamingEvents from './useStreamingEvents'
import { useChatStore } from '@/store/chat-store'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'

const {
  mockInvoke,
  mockListen,
  mockSaveWorktreePr,
  mockPlayNotificationSound,
  registeredListeners,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
  mockListen: vi.fn(),
  mockSaveWorktreePr: vi.fn(),
  mockPlayNotificationSound: vi.fn(),
  registeredListeners: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  listen: mockListen,
  useWsConnectionStatus: () => true,
}))

vi.mock('@/lib/sounds', () => ({
  playNotificationSound: mockPlayNotificationSound,
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  saveWorktreePr: mockSaveWorktreePr,
  projectsQueryKeys: {
    all: ['projects'],
    list: () => ['projects'],
  },
}))

function seedWaitingSoundPrefs(
  queryClient: QueryClient,
  waitingSound: AppPreferences['waiting_sound'] = 'workwork'
) {
  queryClient.setQueryData(preferencesQueryKeys.preferences(), {
    waiting_sound: waitingSound,
    web_access_sounds_enabled: true,
    desktop_notifications_enabled: false,
  } as AppPreferences)
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function setupListenMock() {
  vi.clearAllMocks()
  registeredListeners.clear()
  mockInvoke.mockImplementation((command: string) =>
    command === 'list_pending_wakeups'
      ? Promise.resolve([])
      : Promise.resolve(undefined)
  )

  mockListen.mockImplementation(
    (eventName: string, callback: (event: { payload: unknown }) => void) => {
      registeredListeners.set(eventName, callback)
      return Promise.resolve(() => {
        registeredListeners.delete(eventName)
      })
    }
  )
}

describe('useStreamingEvents sending mode sync', () => {
  beforeEach(() => {
    setupListenMock()
    useChatStore.setState({
      sendingSessionIds: {},
      executingModes: {},
      waitingForInputSessionIds: {},
      reviewingSessions: {},
      pendingPermissionDenials: {},
      deniedMessageContext: {},
    })
  })

  it('shows only the prompt the backend started while the next prompt stays queued', async () => {
    const queryClient = createQueryClient()
    const first = {
      id: 'first',
      message: 'first queued prompt',
      pendingImages: [],
      pendingFiles: [],
      pendingSkills: [],
      pendingTextFiles: [],
      model: 'gpt-6-sol-fast',
      provider: null,
      executionMode: 'yolo' as const,
      thinkingLevel: 'off' as const,
      queuedAt: 1,
    }
    const second = { ...first, id: 'second', message: 'second queued prompt' }
    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      messages: [],
    })
    useChatStore.setState({
      messageQueues: {
        'session-1': [first, second],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() =>
      expect(registeredListeners.has('chat:sending')).toBe(true)
    )

    // Rust removes the first prompt from its queue, then reports the exact
    // prompt that it started. The second prompt remains queued.
    useChatStore.setState({
      messageQueues: {
        'session-1': [second],
      },
    })
    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'first queued prompt',
        execution_mode: 'yolo',
      },
    })

    expect(
      queryClient
        .getQueryData<{
          messages: { content: string }[]
        }>(['chat', 'session', 'session-1'])
        ?.messages.map(message => message.content)
    ).toEqual(['first queued prompt'])
    expect(
      useChatStore
        .getState()
        .messageQueues['session-1']?.map(message => message.id)
    ).toEqual(['second'])
  })

  it('flushes live output when the webview does not run animation frames', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const queryClient = createQueryClient()
    renderHook(() => useStreamingEvents({ queryClient }), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() =>
      expect(registeredListeners.has('chat:chunk')).toBe(true)
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Visible without changing sessions.',
        run_id: 'run-1',
      },
    })

    await waitFor(() =>
      expect(useChatStore.getState().streamingContents['session-1']).toBe(
        'Visible without changing sessions.'
      )
    )
  })

  it('uses the execution mode of a turn started through Jean MCP', async () => {
    const queryClient = createQueryClient()
    renderHook(() => useStreamingEvents({ queryClient }), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() =>
      expect(registeredListeners.has('chat:sending')).toBe(true)
    )

    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'run this now',
        execution_mode: 'yolo',
      },
    })

    const state = useChatStore.getState()
    expect(state.sendingSessionIds['session-1']).toBe(true)
    expect(state.executingModes['session-1']).toBe('yolo')
  })

  it('clears old Claude denials when a new prompt starts', async () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      messages: [],
      pending_permission_denials: [{ tool_use_id: 'old-denial' }],
    })
    useChatStore.setState({
      pendingPermissionDenials: {
        'session-1': [
          {
            tool_name: 'Bash',
            tool_use_id: 'old-denial',
            tool_input: {},
          },
        ],
      },
    })
    renderHook(() => useStreamingEvents({ queryClient }), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() =>
      expect(registeredListeners.has('chat:sending')).toBe(true)
    )

    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'new prompt',
        execution_mode: 'yolo',
      },
    })

    expect(
      useChatStore.getState().pendingPermissionDenials['session-1']
    ).toBeUndefined()
    expect(
      queryClient.getQueryData<{ pending_permission_denials: unknown[] }>([
        'chat',
        'session',
        'session-1',
      ])?.pending_permission_denials
    ).toEqual([])
  })

  it('drops the paused question tool state when another client starts a turn (#779)', async () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
    })
    // Paused on an AskUserQuestion; this client is NOT the sender
    // (sendingSessionIds is empty), e.g. web access / queue / MCP.
    useChatStore.setState({
      sendingSessionIds: {},
      waitingForInputSessionIds: { 'session-1': true },
      answeredQuestions: {},
      streamingContents: {},
      activeToolCalls: {
        'session-1': [
          {
            id: 'old-question',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
        'session-2': [{ id: 'other-tool', name: 'Bash', input: {} }],
      },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Which option?' },
          { type: 'tool_use', tool_call_id: 'old-question' },
        ],
        'session-2': [{ type: 'tool_use', tool_call_id: 'other-tool' }],
      },
    })
    renderHook(() => useStreamingEvents({ queryClient }), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(registeredListeners.has('chat:done')).toBe(true))

    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'answer from another client',
        execution_mode: 'build',
      },
    })

    let state = useChatStore.getState()
    expect(state.waitingForInputSessionIds['session-1']).toBeUndefined()
    expect(state.activeToolCalls['session-1']).toBeUndefined()
    expect(state.streamingContentBlocks['session-1']).toBeUndefined()
    // Other sessions untouched
    expect(state.activeToolCalls['session-2']).toHaveLength(1)
    expect(state.streamingContentBlocks['session-2']).toHaveLength(1)

    // New turn finishes without asking anything: the old question must not
    // pause the session again or be baked into the new assistant message.
    useChatStore.setState({
      streamingContents: { 'session-1': 'Done.' },
      streamingContentBlocks: {
        ...useChatStore.getState().streamingContentBlocks,
        'session-1': [{ type: 'text', text: 'Done.' }],
      },
    })
    registeredListeners.get('chat:done')?.({
      payload: { session_id: 'session-1', worktree_id: 'worktree-1' },
    })

    state = useChatStore.getState()
    expect(state.waitingForInputSessionIds['session-1']).toBeUndefined()
    expect(state.activeToolCalls['session-1'] ?? []).toEqual([])
    const messages =
      queryClient.getQueryData<{
        messages: { role: string; tool_calls?: { id: string }[] }[]
      }>(['chat', 'session', 'session-1'])?.messages ?? []
    expect(
      messages.some(message =>
        message.tool_calls?.some(tool => tool.id === 'old-question')
      )
    ).toBe(false)
  })
})

describe('useStreamingEvents Codex MCP elicitation', () => {
  beforeEach(() => {
    setupListenMock()
    mockPlayNotificationSound.mockClear()

    useChatStore.setState({
      enabledMcpServers: {},
      pendingCodexMcpElicitationRequests: {},
      waitingForInputSessionIds: {},
      worktreePaths: {},
    })
  })

  it('auto-accepts Codex MCP elicitation when server is enabled for the session', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    useChatStore.setState({
      enabledMcpServers: {
        'session-1': ['notion'],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 42,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('respond_codex_mcp_elicitation', {
        sessionId: 'session-1',
        rpcId: 42,
        action: 'accept',
      })
    )

    expect(
      useChatStore.getState().pendingCodexMcpElicitationRequests['session-1'] ??
        []
    ).toEqual([])
    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      undefined
    )
  })

  it('queues Codex MCP elicitation when server is not enabled for the session', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient)
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 99,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(
        useChatStore.getState().pendingCodexMcpElicitationRequests['session-1']
      ).toEqual([
        {
          rpc_id: 99,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      ])
    )

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'respond_codex_mcp_elicitation',
      expect.anything()
    )
    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      true
    )
    expect(mockPlayNotificationSound).toHaveBeenCalledWith('workwork', {
      webAccessSoundsEnabled: true,
    })
  })

  it('does not play waiting sound when MCP elicitation is auto-accepted', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient)
    const wrapper = createWrapper(queryClient)

    useChatStore.setState({
      enabledMcpServers: {
        'session-1': ['notion'],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 42,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('respond_codex_mcp_elicitation', {
        sessionId: 'session-1',
        rpcId: 42,
        action: 'accept',
      })
    )

    expect(mockPlayNotificationSound).not.toHaveBeenCalled()
  })
})

describe('useStreamingEvents mid-run waiting sounds', () => {
  beforeEach(() => {
    setupListenMock()
    mockPlayNotificationSound.mockClear()

    useChatStore.setState({
      pendingCodexPermissionRequests: {},
      pendingCodexCommandApprovalRequests: {},
      pendingCodexUserInputRequests: {},
      pendingCodexDynamicToolCallRequests: {},
      waitingForInputSessionIds: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })
  })

  it('plays waiting sound on Codex permission request', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient)
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:codex_permission_request')).toBe(
        true
      )
    )

    registeredListeners.get('chat:codex_permission_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          request_id: 'perm-1',
          permissions: ['network'],
        },
      },
    })

    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      true
    )
    expect(mockPlayNotificationSound).toHaveBeenCalledWith('workwork', {
      webAccessSoundsEnabled: true,
    })
  })

  it('plays waiting sound on Codex command approval request', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient, 'jobsdone')
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_command_approval_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_command_approval_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          request_id: 'cmd-1',
          command: 'rm -rf /',
        },
      },
    })

    expect(mockPlayNotificationSound).toHaveBeenCalledWith('jobsdone', {
      webAccessSoundsEnabled: true,
    })
  })

  it('plays waiting sound on Codex dynamic tool call request', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient)
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_dynamic_tool_call_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_dynamic_tool_call_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          request_id: 'tool-1',
          tool_name: 'custom_tool',
        },
      },
    })

    expect(mockPlayNotificationSound).toHaveBeenCalledWith('workwork', {
      webAccessSoundsEnabled: true,
    })
  })

  it('plays waiting sound once for a new Codex user input request', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient)
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:codex_user_input_request')).toBe(
        true
      )
    )

    const event = {
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 42,
          item_id: 'question-1',
          questions: [
            {
              id: 'model',
              question: 'How should I continue?',
              options: [{ label: 'Wait' }, { label: 'Use Codex' }],
            },
          ],
        },
      },
    }
    const listener = registeredListeners.get('chat:codex_user_input_request')
    listener?.(event)
    listener?.(event)

    expect(mockPlayNotificationSound).toHaveBeenCalledTimes(1)
    expect(mockPlayNotificationSound).toHaveBeenCalledWith('workwork', {
      webAccessSoundsEnabled: true,
    })
  })

  it('does not play when waiting_sound is none', async () => {
    const queryClient = createQueryClient()
    seedWaitingSoundPrefs(queryClient, 'none')
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:codex_permission_request')).toBe(
        true
      )
    )

    registeredListeners.get('chat:codex_permission_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          request_id: 'perm-1',
          permissions: ['network'],
        },
      },
    })

    expect(mockPlayNotificationSound).toHaveBeenCalledWith('none', {
      webAccessSoundsEnabled: true,
    })
  })
})

describe('useStreamingEvents Codex user input', () => {
  beforeEach(() => {
    setupListenMock()
    mockPlayNotificationSound.mockClear()

    useChatStore.setState({
      pendingCodexUserInputRequests: {},
      waitingForInputSessionIds: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })
  })

  it('upserts a repeated request instead of rendering a second prompt', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:codex_user_input_request')).toBe(
        true
      )
    )

    const event = {
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 42,
          item_id: 'question-1',
          questions: [
            {
              id: 'model',
              question: 'How should I continue?',
              options: [{ label: 'Wait' }, { label: 'Use Codex' }],
            },
          ],
        },
      },
    }
    const listener = registeredListeners.get('chat:codex_user_input_request')
    listener?.(event)
    listener?.(event)

    expect(
      useChatStore.getState().pendingCodexUserInputRequests['session-1']
    ).toHaveLength(1)
    expect(useChatStore.getState().activeToolCalls['session-1']).toHaveLength(1)
    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [{ type: 'tool_use', tool_call_id: 'question-1' }]
    )
  })
})

describe('useStreamingEvents cancellation sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()

    mockListen.mockImplementation(
      (eventName: string, callback: (event: { payload: unknown }) => void) => {
        registeredListeners.set(eventName, callback)
        return Promise.resolve(() => {
          registeredListeners.delete(eventName)
        })
      }
    )

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingReplayContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {},
      sendingSessionIds: {},
      sendStartedAt: {},
      sessionWorktreeMap: {},
      worktreePaths: {},
      messageQueues: {},
      lastSentMessages: {},
      compactingSessions: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not park a plain plan completion when prompts are queued', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'user-1',
          session_id: 'session-1',
          role: 'user',
          content: 'hello',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })
    queryClient.setQueryData(['chat', 'sessions', 'worktree-1'], {
      worktree_id: 'worktree-1',
      sessions: [
        {
          id: 'session-1',
          name: 'Test',
          order: 0,
          created_at: 1,
          updated_at: 1,
          messages: [],
        },
      ],
    })
    useChatStore.setState({
      streamingContents: { 'session-1': 'Hello. What would you like to do?' },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Hello. What would you like to do?' },
        ],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
      messageQueues: {
        'session-1': [
          {
            id: 'queued-1',
            message: 'who are you',
            pendingImages: [],
            pendingFiles: [],
            pendingSkills: [],
            pendingTextFiles: [],
            model: 'opencode/gpt-5.5',
            provider: null,
            executionMode: 'plan',
            thinkingLevel: 'off',
            backend: 'opencode',
            queuedAt: 1,
          },
        ],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() => expect(registeredListeners.has('chat:done')).toBe(true))

    registeredListeners.get('chat:done')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        waiting_for_plan: true,
      },
    })

    expect(
      useChatStore.getState().waitingForInputSessionIds['session-1']
    ).toBeUndefined()
    expect(useChatStore.getState().sendingSessionIds['session-1']).toBe(
      undefined
    )
    expect(
      queryClient.getQueryData<{ waiting_for_input?: boolean }>([
        'chat',
        'session',
        'session-1',
      ])?.waiting_for_input
    ).not.toBe(true)
  })

  it('does not turn a normal completed session into review loading when a finished review session exists', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'normal-session'], {
      id: 'normal-session',
      name: 'Normal session',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'user-1',
          session_id: 'normal-session',
          role: 'user',
          content: 'finish this task',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })
    queryClient.setQueryData(['chat', 'sessions', 'worktree-1'], {
      worktree_id: 'worktree-1',
      sessions: [
        {
          id: 'normal-session',
          name: 'Normal session',
          order: 0,
          created_at: 1,
          updated_at: 1,
          messages: [],
          is_reviewing: false,
        },
        {
          id: 'review-session',
          name: 'Code Review',
          order: 1,
          created_at: 2,
          updated_at: 2,
          messages: [],
          is_reviewing: false,
          review_results: {
            summary: 'Review finished.',
            approval_status: 'approved',
            findings: [],
          },
        },
      ],
    })
    queryClient.setQueryData(
      ['chat', 'sessions', 'worktree-1', 'with-counts'],
      {
        worktree_id: 'worktree-1',
        sessions: [
          {
            id: 'normal-session',
            name: 'Normal session',
            order: 0,
            created_at: 1,
            updated_at: 1,
            messages: [],
            is_reviewing: false,
            last_run_status: 'running',
          },
        ],
      }
    )

    useChatStore.setState({
      streamingContents: { 'normal-session': 'Done.' },
      streamingContentBlocks: {
        'normal-session': [{ type: 'text', text: 'Done.' }],
      },
      sendingSessionIds: { 'normal-session': true },
      sendStartedAt: { 'normal-session': 1000 },
      sessionWorktreeMap: {
        'normal-session': 'worktree-1',
        'review-session': 'worktree-1',
      },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
      reviewingSessions: {},
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() => expect(registeredListeners.has('chat:done')).toBe(true))

    registeredListeners.get('chat:done')?.({
      payload: {
        session_id: 'normal-session',
        worktree_id: 'worktree-1',
      },
    })

    expect(
      queryClient.getQueryData<{ is_reviewing?: boolean }>([
        'chat',
        'session',
        'normal-session',
      ])?.is_reviewing
    ).toBe(false)
    const sessionsCache = queryClient.getQueryData<{
      sessions: { id: string; is_reviewing?: boolean }[]
    }>(['chat', 'sessions', 'worktree-1'])
    expect(
      sessionsCache?.sessions.find(s => s.id === 'normal-session')?.is_reviewing
    ).toBe(false)
    expect(
      sessionsCache?.sessions.find(s => s.id === 'review-session')?.is_reviewing
    ).toBe(false)
    expect(
      useChatStore.getState().reviewingSessions['normal-session']
    ).toBeUndefined()
    const canvasSessionsCache = queryClient.getQueryData<{
      sessions: { id: string; last_run_status?: string }[]
    }>(['chat', 'sessions', 'worktree-1', 'with-counts'])
    expect(
      canvasSessionsCache?.sessions.find(s => s.id === 'normal-session')
        ?.last_run_status
    ).toBe('completed')
  })

  it('keeps the prompt and the partial assistant output (incl tool calls) when cancelling a partial response', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)
    const compactSummary =
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n- old compacted work\n\nContinue the conversation from where it left off without asking the user any further questions.'

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'user-1',
          session_id: 'session-1',
          role: 'user',
          content: 'continue',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {
        'session-1': `${compactSummary}Actual partial response.`,
      },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: compactSummary },
          { type: 'text', text: 'Actual partial response.' },
        ],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
      },
    })

    const session = queryClient.getQueryData<{
      messages: {
        role: string
        content: string
        cancelled?: boolean
        content_blocks?: { type: string; text?: string }[]
      }[]
    }>(['chat', 'session', 'session-1'])
    // Prompt stays, plus a cancelled assistant turn with the compaction summary
    // stripped from the persisted/visible partial content.
    expect(session?.messages.map(message => message.content)).toEqual([
      'continue',
      'Actual partial response.',
    ])
    const assistant = session?.messages[1]
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.cancelled).toBe(true)
    expect(assistant?.content_blocks).toEqual([
      { type: 'text', text: 'Actual partial response.' },
    ])
    // Partial content is persisted to the run JSONL so it survives reload.
    expect(mockInvoke).toHaveBeenCalledWith(
      'save_cancelled_message',
      expect.objectContaining({
        sessionId: 'session-1',
        content: 'Actual partial response.',
      })
    )
    expect(useChatStore.getState().isSessionReviewing('session-1')).toBe(true)

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Late cancelled chunk.',
      },
    })

    expect(useChatStore.getState().sendingSessionIds['session-1']).toBe(
      undefined
    )
    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      undefined
    )
  })

  it('keeps prior history, current prompt, and the cancelled partial assistant turn', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'old-user',
          session_id: 'session-1',
          role: 'user',
          content: 'old prompt',
          timestamp: 1,
          tool_calls: [],
        },
        {
          id: 'old-assistant',
          session_id: 'session-1',
          role: 'assistant',
          content: 'old answer',
          timestamp: 2,
          tool_calls: [],
        },
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this',
          timestamp: 3,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: { 'session-1': 'Partial response.' },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'Partial response.' }],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
      },
    })

    const session = queryClient.getQueryData<{
      messages: {
        id: string
        role: string
        content: string
        cancelled?: boolean
      }[]
    }>(['chat', 'session', 'session-1'])

    // Prior history + current prompt + the cancelled partial assistant turn.
    expect(session?.messages.map(message => message.id)).toEqual([
      'old-user',
      'old-assistant',
      'current-user',
      'cancelled-session-1-2000',
    ])
    const cancelledTurn = session?.messages[3]
    expect(cancelledTurn?.role).toBe('assistant')
    expect(cancelledTurn?.content).toBe('Partial response.')
    expect(cancelledTurn?.cancelled).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith(
      'save_cancelled_message',
      expect.objectContaining({ sessionId: 'session-1' })
    )
    expect(useChatStore.getState().isSessionReviewing('session-1')).toBe(true)
  })

  it('keeps the sent prompt on chat:error after tool calls without text', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_pending_wakeups') return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'run tools',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {
        'session-1': [{ id: 'tool-1', name: 'Read', input: {} }],
      },
      sendingSessionIds: { 'session-1': true },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      lastSentMessages: { 'session-1': 'run tools' },
      inputDrafts: { 'session-1': '' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:error')).toBe(true)
    )

    registeredListeners.get('chat:error')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        error: 'API Error: overloaded',
      },
    })

    const session = queryClient.getQueryData<{
      messages: { id: string }[]
    }>(['chat', 'session', 'session-1'])
    expect(session?.messages.map(message => message.id)).toContain(
      'current-user'
    )
    expect(useChatStore.getState().inputDrafts['session-1']).toBe('')
  })

  it('restores text and images when an already-running prompt is cancelled before output', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)
    const hiddenRunSession = {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
    }

    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_pending_wakeups') return Promise.resolve([])
      if (command === 'get_session') return Promise.resolve(hiddenRunSession)
      return Promise.resolve(undefined)
    })

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'already running',
          timestamp: 3,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {},
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
      lastSentMessages: { 'session-1': 'already running' },
      lastSentAttachments: {
        'session-1': {
          images: [
            {
              id: 'image-1',
              path: '/tmp/image.png',
              filename: 'image.png',
            },
          ],
          files: [],
          textFiles: [],
          skills: [],
        },
      },
      pendingImages: {},
      inputDrafts: { 'session-1': '' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
      },
    })

    const session = queryClient.getQueryData<{
      messages: { id: string; role: string; content: string }[]
    }>(['chat', 'session', 'session-1'])

    expect(session?.messages.map(message => message.id)).not.toContain(
      'current-user'
    )
    expect(useChatStore.getState().inputDrafts['session-1']).toBe(
      'already running'
    )
    expect(useChatStore.getState().pendingImages['session-1']).toEqual([
      {
        id: 'image-1',
        path: '/tmp/image.png',
        filename: 'image.png',
      },
    ])
    expect(
      useChatStore.getState().lastSentAttachments['session-1']
    ).toBeUndefined()
    expect(useChatStore.getState().lastSentMessages['session-1']).toBe(
      undefined
    )
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('get_session', {
        sessionId: 'session-1',
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree',
      })
    )
    expect(useChatStore.getState().inputDrafts['session-1']).toBe(
      'already running'
    )
  })

  it('hydrates a persisted cancelled turn without restoring the sent prompt', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)
    const hydratedSession = {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 4,
      last_run_status: 'cancelled',
      messages: [
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'already running',
          timestamp: 3,
          tool_calls: [],
        },
        {
          id: 'persisted-cancelled-assistant',
          session_id: 'session-1',
          role: 'assistant',
          content: 'Persisted cancelled answer.',
          timestamp: 4,
          tool_calls: [],
          content_blocks: [
            { type: 'text', text: 'Persisted cancelled answer.' },
          ],
          cancelled: true,
        },
      ],
    }

    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_pending_wakeups') return Promise.resolve([])
      if (command === 'get_session') return Promise.resolve(hydratedSession)
      return Promise.resolve(undefined)
    })

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 3,
      messages: [
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'already running',
          timestamp: 3,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {},
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
      lastSentMessages: { 'session-1': 'already running' },
      inputDrafts: { 'session-1': '' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
        run_id: 'run-with-persisted-output',
      },
    })

    // Restore immediately because the client has not received any output yet.
    expect(useChatStore.getState().inputDrafts['session-1']).toBe(
      'already running'
    )

    await waitFor(() => {
      const session = queryClient.getQueryData<{
        messages: { id: string }[]
      }>(['chat', 'session', 'session-1'])
      expect(session?.messages.map(message => message.id)).toEqual([
        'current-user',
        'persisted-cancelled-assistant',
      ])
    })

    expect(useChatStore.getState().inputDrafts['session-1'] ?? '').toBe('')
  })

  it('restores an instant-cancelled prompt while keeping prior history visible', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'old-user',
          session_id: 'session-1',
          role: 'user',
          content: 'old prompt',
          timestamp: 1,
          tool_calls: [],
        },
        {
          id: 'old-assistant',
          session_id: 'session-1',
          role: 'assistant',
          content: 'old answer',
          timestamp: 2,
          tool_calls: [],
        },
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this',
          timestamp: 3,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {},
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
      lastSentMessages: { 'session-1': 'cancel this' },
      lastSentAttachments: {
        'session-1': {
          images: [
            {
              id: 'image-1',
              path: '/tmp/image.png',
              filename: 'image.png',
            },
          ],
          files: [],
          textFiles: [],
          skills: [],
        },
      },
      pendingImages: {},
      inputDrafts: { 'session-1': '' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: true,
        emitted_at_ms: 2000,
      },
    })

    const session = queryClient.getQueryData<{
      messages: { id: string; role: string; content: string }[]
    }>(['chat', 'session', 'session-1'])

    expect(session?.messages.map(message => message.id)).toEqual([
      'old-user',
      'old-assistant',
    ])
    expect(useChatStore.getState().inputDrafts['session-1']).toBe('cancel this')
    expect(useChatStore.getState().pendingImages['session-1']).toEqual([
      {
        id: 'image-1',
        path: '/tmp/image.png',
        filename: 'image.png',
      },
    ])
    expect(useChatStore.getState().lastSentMessages['session-1']).toBe(
      undefined
    )
    expect(useChatStore.getState().isSessionReviewing('session-1')).toBe(true)
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'get_session',
      expect.anything()
    )
  })

  // Backend may not have saved the cancelled prompt yet, or saved only the
  // prompt. Either way, the earlier reply must not clear the restored draft.
  const priorMessages = [
    {
      id: 'old-user',
      session_id: 'session-1',
      role: 'user',
      content: 'old prompt',
      timestamp: 1,
      tool_calls: [],
    },
    {
      id: 'old-assistant',
      session_id: 'session-1',
      role: 'assistant',
      content: 'old answer',
      timestamp: 2,
      tool_calls: [],
    },
  ]
  const currentUser = {
    id: 'current-user',
    session_id: 'session-1',
    role: 'user',
    content: 'cancel this',
    timestamp: 3,
    tool_calls: [],
  }

  it.each([
    ['without the cancelled prompt', priorMessages],
    ['with only the cancelled prompt', [...priorMessages, currentUser]],
  ])(
    'keeps the restored draft when the backend has an earlier reply %s',
    async (_label, backendMessages) => {
      const queryClient = createQueryClient()
      const wrapper = createWrapper(queryClient)

      mockInvoke.mockImplementation((command: string) => {
        if (command === 'list_pending_wakeups') return Promise.resolve([])
        if (command === 'get_session')
          return Promise.resolve({
            id: 'session-1',
            name: 'Test',
            order: 0,
            created_at: 1,
            updated_at: 3,
            messages: backendMessages,
          })
        return Promise.resolve(undefined)
      })

      queryClient.setQueryData(['chat', 'session', 'session-1'], {
        id: 'session-1',
        name: 'Test',
        order: 0,
        created_at: 1,
        updated_at: 3,
        messages: [...priorMessages, currentUser],
      })

      useChatStore.setState({
        streamingContents: {},
        streamingContentBlocks: {},
        streamingThinkingContent: {},
        activeToolCalls: {},
        sendingSessionIds: { 'session-1': true },
        sendStartedAt: { 'session-1': 1000 },
        sessionWorktreeMap: { 'session-1': 'worktree-1' },
        worktreePaths: { 'worktree-1': '/tmp/worktree' },
        lastSentMessages: { 'session-1': 'cancel this' },
        inputDrafts: { 'session-1': '' },
      })

      renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

      await waitFor(() =>
        expect(registeredListeners.has('chat:cancelled')).toBe(true)
      )

      mockInvoke.mockClear()
      registeredListeners.get('chat:cancelled')?.({
        payload: {
          session_id: 'session-1',
          worktree_id: 'worktree-1',
          undo_send: false,
          emitted_at_ms: 2000,
          run_id: `run-${backendMessages.length}`,
        },
      })

      expect(useChatStore.getState().inputDrafts['session-1']).toBe(
        'cancel this'
      )

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith('get_session', {
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          worktreePath: '/tmp/worktree',
        })
      )
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(useChatStore.getState().inputDrafts['session-1']).toBe(
        'cancel this'
      )
    }
  )

  it('hydrates persisted cancelled output without clearing a newer input draft', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    const hydratedSession = {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 4,
      last_run_status: 'cancelled',
      messages: [
        {
          id: 'old-user',
          session_id: 'session-1',
          role: 'user',
          content: 'old prompt',
          timestamp: 1,
          tool_calls: [],
        },
        {
          id: 'old-assistant',
          session_id: 'session-1',
          role: 'assistant',
          content: 'old answer',
          timestamp: 2,
          tool_calls: [],
        },
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this after output persisted',
          timestamp: 3,
          tool_calls: [],
        },
        {
          id: 'persisted-cancelled-assistant',
          session_id: 'session-1',
          role: 'assistant',
          content: 'Persisted cancelled answer.',
          timestamp: 4,
          tool_calls: [],
          content_blocks: [
            { type: 'text', text: 'Persisted cancelled answer.' },
          ],
          cancelled: true,
        },
      ],
    }

    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_pending_wakeups') return Promise.resolve([])
      if (command === 'get_session') return Promise.resolve(hydratedSession)
      return Promise.resolve(undefined)
    })

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 3,
      messages: [
        {
          id: 'old-user',
          session_id: 'session-1',
          role: 'user',
          content: 'old prompt',
          timestamp: 1,
          tool_calls: [],
        },
        {
          id: 'old-assistant',
          session_id: 'session-1',
          role: 'assistant',
          content: 'old answer',
          timestamp: 2,
          tool_calls: [],
        },
        {
          id: 'current-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this after output persisted',
          timestamp: 3,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {},
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
      lastSentMessages: {
        'session-1': 'cancel this after output persisted',
      },
      inputDrafts: { 'session-1': 'keep this draft' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
        run_id: 'run-with-persisted-output',
      },
    })

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('get_session', {
        sessionId: 'session-1',
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree',
      })
    )

    await waitFor(() => {
      const session = queryClient.getQueryData<{
        messages: {
          id: string
          role: string
          content: string
          cancelled?: boolean
        }[]
      }>(['chat', 'session', 'session-1'])

      expect(session?.messages.map(message => message.id)).toEqual([
        'old-user',
        'old-assistant',
        'current-user',
        'persisted-cancelled-assistant',
      ])
      expect(session?.messages[3]?.content).toBe('Persisted cancelled answer.')
      expect(session?.messages[3]?.cancelled).toBe(true)
    })

    expect(useChatStore.getState().inputDrafts['session-1']).toBe(
      'keep this draft'
    )
  })

  it('ignores late chunks from a cancelled run after the same session starts a new run', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'cancelled-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: { 'session-1': 'Partial response.' },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'Partial response.' }],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
        run_id: 'run-old',
      },
    })

    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'new prompt',
      },
    })

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Late cancelled chunk.',
        run_id: 'run-old',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      undefined
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'New run chunk.',
        run_id: 'run-new',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'New run chunk.'
    )
  })

  it('ignores late untagged chunks after a tagged cancellation', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [],
    })

    useChatStore.setState({
      streamingContents: { 'session-1': 'Partial response.' },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'Partial response.' }],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
        run_id: 'run-old',
      },
    })

    // Session persistence may restore is_reviewing=false before a delayed
    // backend chunk arrives, so cancellation filtering cannot rely on it.
    useChatStore.getState().setSessionReviewing('session-1', false)

    const chunkListener = registeredListeners.get('chat:chunk')
    expect(chunkListener).toBeDefined()
    chunkListener?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Late untagged Grok chunk.',
      },
    })

    expect(
      useChatStore.getState().sendingSessionIds['session-1']
    ).toBeUndefined()
    expect(
      useChatStore.getState().streamingContents['session-1']
    ).toBeUndefined()
  })

  it('continues ignoring cancelled run chunks after accepting a new run chunk', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'cancelled-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: { 'session-1': 'Partial response.' },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'Partial response.' }],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
        run_id: 'run-old',
      },
    })

    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'new prompt',
      },
    })

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'New run chunk.',
        run_id: 'run-new',
      },
    })

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Late cancelled chunk.',
        run_id: 'run-old',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'New run chunk.'
    )
  })

  it('accepts untagged new run chunks after a tagged cancellation and restart', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'cancelled-user',
          session_id: 'session-1',
          role: 'user',
          content: 'cancel this',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: { 'session-1': 'Partial response.' },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'Partial response.' }],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
        run_id: 'run-old',
      },
    })

    registeredListeners.get('chat:sending')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        user_message: 'new prompt',
      },
    })

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Untagged new run chunk.',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'Untagged new run chunk.'
    )
  })
})

describe('useStreamingEvents replay dedupe', () => {
  beforeEach(() => {
    setupListenMock()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContents: { 'session-1': 'Before tool. After tool.' },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Before tool. ' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'After tool.' },
        ],
      },
      streamingReplayContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Before tool. ' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'After tool.' },
        ],
      },
      activeToolCalls: {
        'session-1': [{ id: 'tool-1', name: 'Bash', input: {} }],
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops replayed chunk and tool-block events from recovered running snapshots', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:chunk')).toBe(true)
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Before tool. ',
      },
    })
    registeredListeners.get('chat:tool_block')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_call_id: 'tool-1',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'After tool.',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'Before tool. After tool.'
    )
    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'Before tool. ' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'text', text: 'After tool.' },
      ]
    )
    expect(
      useChatStore.getState().streamingReplayContentBlocks['session-1']
    ).toBeUndefined()
  })

  it('does not double snapshot content when Grok re-emits tool_block for the same id', async () => {
    // Reproduces web reconnect while Grok is mid-turn: the running snapshot is
    // hydrated with dedupe blocks, then the WS buffer replays tool_use/tool_block
    // pairs — including a second tool_block for the same id from tool_call_update.
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:tool_block')).toBe(true)
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Before tool. ',
      },
    })
    registeredListeners.get('chat:tool_block')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_call_id: 'tool-1',
      },
    })
    // Grok ACP tool_call_update re-emits the same tool_block.
    registeredListeners.get('chat:tool_block')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_call_id: 'tool-1',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'After tool.',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'Before tool. After tool.'
    )
    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'Before tool. ' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'text', text: 'After tool.' },
      ]
    )
    // Must not become: Before, tool, After, Before, tool, After
    const blocks = useChatStore.getState().streamingContentBlocks['session-1']
    const textBlocks = blocks?.filter(b => b.type === 'text') ?? []
    expect(textBlocks).toHaveLength(2)
  })

  it('keeps deduplicating snapshot output when replay contains unpersisted thinking', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:thinking')).toBe(true)
    )

    registeredListeners.get('chat:thinking')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Reasoning omitted from the running snapshot.',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Before tool. ',
      },
    })
    registeredListeners.get('chat:tool_block')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_call_id: 'tool-1',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'After tool.',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'Before tool. After tool.'
    )
    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'Before tool. ' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'text', text: 'After tool.' },
      ]
    )
    expect(
      useChatStore.getState().streamingReplayContentBlocks['session-1']
    ).toBeUndefined()
  })

  it('does not duplicate a steered prompt already present in the running snapshot', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    useChatStore.setState({
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Before steering.' },
          { type: 'user_input', text: 'Also fix the header.' },
          { type: 'text', text: 'After steering.' },
        ],
      },
      streamingReplayContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Before steering.' },
          { type: 'user_input', text: 'Also fix the header.' },
          { type: 'text', text: 'After steering.' },
        ],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:steered')).toBe(true)
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Before steering.',
      },
    })
    registeredListeners.get('chat:steered')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        text: 'Also fix the header.',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'After steering.',
      },
    })

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'Before steering.' },
        { type: 'user_input', text: 'Also fix the header.' },
        { type: 'text', text: 'After steering.' },
      ]
    )
    expect(
      useChatStore.getState().streamingReplayContentBlocks['session-1']
    ).toBeUndefined()
  })
})

describe('useStreamingEvents ordered blocks flush buffered stream', () => {
  beforeEach(() => {
    setupListenMock()
    // Never fire animation frames: chunks/thinking stay buffered until an
    // ordered event (tool block, steer) forces a flush.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      reviewingSessions: {},
      streamingContents: {},
      streamingContentBlocks: {},
      streamingReplayContentBlocks: {},
      activeToolCalls: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('commits buffered thinking and text before adding a tool block', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:tool_block')).toBe(true)
    )

    registeredListeners.get('chat:thinking')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Considering.',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Let me check.',
      },
    })
    registeredListeners.get('chat:tool_block')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_call_id: 'tool-1',
      },
    })

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'thinking', thinking: 'Considering.' },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
      ]
    )
    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'Let me check.'
    )
  })

  it('commits buffered text before a steered user input block', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:steered')).toBe(true)
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Working on it.',
      },
    })
    registeredListeners.get('chat:steered')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        text: 'also do X',
      },
    })

    const blocks = useChatStore.getState().streamingContentBlocks['session-1']
    expect(blocks?.[0]).toEqual({ type: 'text', text: 'Working on it.' })
    expect(blocks?.[1]?.type).toBe('user_input')
  })
})

describe('useStreamingEvents tool results', () => {
  beforeEach(() => {
    setupListenMock()
    useChatStore.setState({
      pendingPermissionDenials: {},
      activeToolCalls: {
        'session-1': [{ id: 'tool-1', name: 'Bash', input: { command: 'x' } }],
      },
    })
  })

  it('stores is_error from chat:tool_result on the tool call', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:tool_result')).toBe(true)
    )

    registeredListeners.get('chat:tool_result')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_use_id: 'tool-1',
        output: 'command not found',
        is_error: true,
      },
    })

    const toolCall = useChatStore.getState().activeToolCalls['session-1']?.[0]
    expect(toolCall?.output).toBe('command not found')
    expect(toolCall?.is_error).toBe(true)
  })
})
