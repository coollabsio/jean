import { act, renderHook } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefObject } from 'react'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { chatQueryKeys } from '@/services/chat'
import type { Session } from '@/types/chat'
import { useToolbarHandlers } from './useToolbarHandlers'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

const invokeMock = vi.mocked(invoke)

const ref = <T,>(current: T): RefObject<T> => ({ current })

const baseSession: Session = {
  id: 'session-1',
  name: 'Session 1',
  order: 0,
  created_at: 1,
  updated_at: 1,
  messages: [],
  backend: 'claude',
  selected_model: 'claude-opus-4-8',
  selected_thinking_level: 'off',
  selected_execution_mode: 'plan',
}

function renderHandlers(
  overrides: Partial<Parameters<typeof useToolbarHandlers>[0]> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(chatQueryKeys.session('session-1'), baseSession)

  const setSessionEffortLevel = { mutate: vi.fn() }

  const hook = renderHook(() =>
    useToolbarHandlers({
      activeSessionId: 'session-1',
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/tmp/worktree',
      activeSessionIdRef: ref('session-1'),
      activeWorktreeIdRef: ref('worktree-1'),
      activeWorktreePathRef: ref('/tmp/worktree'),
      enabledMcpServersRef: ref([]),
      selectedBackend: 'claude',
      installedBackends: ['claude'],
      session: baseSession,
      preferences: { default_execution_mode: 'plan' },
      queryClient,
      worktreeProjectId: 'project-1',
      setSessionModel: { mutate: vi.fn() },
      setSessionBackend: { mutate: vi.fn() },
      setSessionProvider: { mutate: vi.fn() },
      setSessionThinkingLevel: { mutate: vi.fn() },
      setSessionEffortLevel,
      setExecutionMode: vi.fn(),
      setLoadContextModalOpen: vi.fn(),
      ...overrides,
    })
  )

  return { ...hook, queryClient, setSessionEffortLevel }
}

describe('useToolbarHandlers', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    useChatStore.setState({
      effortLevels: {},
      selectedProviders: {},
      selectedBackends: {},
    })
  })

  it('persists effort level changes to session metadata and broadcasts them', () => {
    const { result, queryClient, setSessionEffortLevel } = renderHandlers()

    act(() => {
      result.current.handleToolbarEffortLevelChange('xhigh')
    })

    expect(useChatStore.getState().effortLevels['session-1']).toBe('xhigh')
    expect(setSessionEffortLevel.mutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
      effortLevel: 'xhigh',
    })
    expect(
      queryClient.getQueryData<Session>(chatQueryKeys.session('session-1'))
        ?.selected_effort_level
    ).toBe('xhigh')
    expect(invokeMock).toHaveBeenCalledWith('broadcast_session_setting', {
      sessionId: 'session-1',
      key: 'effortLevel',
      value: 'xhigh',
    })
  })

  it('persists provider changes mid-session with optimistic cache and broadcast', () => {
    const setSessionProvider = { mutate: vi.fn() }
    const { result, queryClient } = renderHandlers({
      setSessionProvider,
      session: {
        ...baseSession,
        selected_provider: 'Z.ai',
        messages: [
          {
            id: 'message-1',
            session_id: 'session-1',
            role: 'user',
            content: 'hello',
            timestamp: 1,
            tool_calls: [],
          },
        ],
      },
    })
    queryClient.setQueryData(chatQueryKeys.session('session-1'), {
      ...baseSession,
      selected_provider: 'Z.ai',
    })

    act(() => {
      result.current.handleToolbarProviderChange('MiniMax')
    })

    expect(useChatStore.getState().selectedProviders['session-1']).toBe(
      'MiniMax'
    )
    expect(setSessionProvider.mutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
      provider: 'MiniMax',
    })
    expect(
      queryClient.getQueryData<Session>(chatQueryKeys.session('session-1'))
        ?.selected_provider
    ).toBe('MiniMax')
    expect(invokeMock).toHaveBeenCalledWith('broadcast_session_setting', {
      sessionId: 'session-1',
      key: 'provider',
      value: 'MiniMax',
    })
  })

  it('clears provider selection when switching back to the default', () => {
    const setSessionProvider = { mutate: vi.fn() }
    const { result, queryClient } = renderHandlers({
      setSessionProvider,
      session: {
        ...baseSession,
        selected_provider: 'MiniMax',
      },
    })
    queryClient.setQueryData(chatQueryKeys.session('session-1'), {
      ...baseSession,
      selected_provider: 'MiniMax',
    })

    act(() => {
      result.current.handleToolbarProviderChange(null)
    })

    expect(useChatStore.getState().selectedProviders['session-1']).toBeNull()
    expect(setSessionProvider.mutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
      provider: null,
    })
    expect(
      queryClient.getQueryData<Session>(chatQueryKeys.session('session-1'))
        ?.selected_provider
    ).toBeUndefined()
    expect(invokeMock).toHaveBeenCalledWith('broadcast_session_setting', {
      sessionId: 'session-1',
      key: 'provider',
      value: '',
    })
  })

  it('cycles backend with Tab even after the session has messages', () => {
    const { result } = renderHandlers({
      installedBackends: ['claude', 'codex'],
      session: {
        ...baseSession,
        messages: [
          {
            id: 'message-1',
            session_id: 'session-1',
            role: 'user',
            content: 'hello',
            timestamp: 1,
            tool_calls: [],
          },
        ],
      },
      preferences: {
        default_execution_mode: 'plan',
        selected_codex_model: 'gpt-5.5',
      },
    })

    act(() => {
      result.current.handleTabBackendSwitch()
    })

    expect(useChatStore.getState().selectedBackends['session-1']).toBe('codex')
  })
})
