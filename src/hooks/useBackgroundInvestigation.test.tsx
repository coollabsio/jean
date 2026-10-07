import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
import { projectsQueryKeys } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Worktree } from '@/types/projects'
import { useBackgroundInvestigation } from './useBackgroundInvestigation'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))

let preferencesData: Record<string, unknown> = {}

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: preferencesData }),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

describe('useBackgroundInvestigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    preferencesData = {}
    useChatStore.setState({
      activeWorktreeId: null,
      executionModes: {},
      worktreePaths: { 'worktree-1': '/tmp/worktree-1' },
    })
    useUIStore.setState({
      autoInvestigateWorktreeIds: new Set(['worktree-1']),
      autoInvestigatePRWorktreeIds: new Set(),
      autoInvestigateSecurityAlertWorktreeIds: new Set(),
      autoInvestigateAdvisoryWorktreeIds: new Set(),
      autoInvestigateLinearIssueWorktreeIds: new Set(),
      autoInvestigateSentryIssueWorktreeIds: new Set(),
      autoOpenSessionWorktreeIds: new Set(),
      autoInvestigateOverrides: {},
    })
  })

  it.each([
    {
      backend: 'claude' as const,
      model: 'opus',
      provider: 'team-profile',
      expectedProvider: 'team-profile',
    },
    {
      backend: 'codex' as const,
      model: 'custom-model',
      provider: 'team-profile',
      expectedProvider: null,
    },
  ])(
    'uses and consumes the $backend investigation override',
    async ({ backend, model, provider, expectedProvider }) => {
      preferencesData = {
        magic_prompt_models: { investigate_issue_model: 'sonnet' },
        magic_prompt_providers: { investigate_issue_provider: null },
      }
      useUIStore.setState({
        autoInvestigateOverrides: {
          'worktree-1': { backend, model, provider },
        },
      })

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      queryClient.setQueryData<Worktree>(
        [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
        {
          id: 'worktree-1',
          project_id: 'project-1',
          path: '/tmp/worktree-1',
          status: 'ready',
        } as Worktree
      )

      vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'list_loaded_issue_contexts') return [{ number: 42 }]
        if (command === 'start_background_investigation') {
          return {
            sessionId: 'session-1',
            worktreeId: 'worktree-1',
            status: 'investigation_started',
          }
        }
        throw new Error(`Unexpected command: ${command}`)
      })

      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      )
      renderHook(() => useBackgroundInvestigation(), { wrapper })

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          'start_background_investigation',
          expect.objectContaining({
            backend,
            model,
            provider: expectedProvider,
          })
        )
      })
      await waitFor(() => {
        expect(useUIStore.getState().autoInvestigateOverrides).toEqual({})
      })
    }
  )

  it('passes the selected issue to the backend for attachment to the new session', async () => {
    preferencesData = {}
    useUIStore.setState({
      autoInvestigateOverrides: {
        'worktree-1': {
          prompt: 'Investigate issue #42\n\nIssue details',
          forceNewSession: true,
          issueContext: {
            number: 42,
            title: 'Issue title',
            body: 'Issue details',
            comments: [],
          },
        },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData<Worktree>(
      [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
      {
        id: 'worktree-1',
        project_id: 'project-1',
        path: '/tmp/worktree-1',
        status: 'ready',
      } as Worktree
    )
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'session-2',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.objectContaining({
          message: 'Investigate issue #42\n\nIssue details',
          forceNewSession: true,
          issueContext: {
            number: 42,
            title: 'Issue title',
            body: 'Issue details',
            comments: [],
          },
        })
      )
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'list_loaded_issue_contexts',
      expect.anything()
    )
  })

  it('selects the created session before opening its worktree modal', async () => {
    preferencesData = {}
    useUIStore.setState({
      autoInvestigateOverrides: {
        'worktree-1': {
          prompt: 'Investigate issue #42',
          forceNewSession: true,
          openSession: true,
        },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData<Worktree>(
      [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
      {
        id: 'worktree-1',
        project_id: 'project-1',
        path: '/tmp/worktree-1',
        status: 'ready',
      } as Worktree
    )
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'new-session',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const openEvents: CustomEvent[] = []
    const listener = (event: Event) => openEvents.push(event as CustomEvent)
    window.addEventListener('open-session-modal', listener)

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => expect(openEvents).toHaveLength(1))
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'new-session'
    )
    expect(openEvents[0]?.detail).toEqual({
      sessionId: 'new-session',
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
    })
    window.removeEventListener('open-session-modal', listener)
  })

  it('keeps the investigation pending when starting it fails', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData<Worktree>(
      [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
      {
        id: 'worktree-1',
        project_id: 'project-1',
        path: '/tmp/worktree-1',
        status: 'ready',
      } as Worktree
    )

    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_issue_contexts') return [{ number: 42 }]
      if (command === 'start_background_investigation') {
        throw new Error('temporary start failure')
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.any(Object)
      )
    })

    expect(
      useUIStore.getState().autoInvestigateWorktreeIds.has('worktree-1')
    ).toBe(true)
  })

  it('starts when the current project worktree becomes ready without navigation', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const cacheKey = [
      ...projectsQueryKeys.all,
      'worktree',
      'worktree-1',
    ] as const
    queryClient.setQueryData<Worktree>(cacheKey, {
      id: 'worktree-1',
      project_id: 'project-1',
      path: '/tmp/worktree-1',
      status: 'pending',
    } as Worktree)

    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_issue_contexts') return [{ number: 42 }]
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    renderHook(() => useBackgroundInvestigation(), { wrapper })

    expect(invoke).not.toHaveBeenCalled()
    act(() => {
      queryClient.setQueryData<Worktree>(cacheKey, old => ({
        ...(old as Worktree),
        status: 'ready',
      }))
    })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.objectContaining({ worktreeId: 'worktree-1' })
      )
    })
  })

  it('consumes the flag when the worktree cache updates during startup', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const cacheKey = [
      ...projectsQueryKeys.all,
      'worktree',
      'worktree-1',
    ] as const
    queryClient.setQueryData<Worktree>(cacheKey, {
      id: 'worktree-1',
      project_id: 'project-1',
      path: '/tmp/worktree-1',
      status: 'ready',
    } as Worktree)

    let finishStart: ((value: unknown) => void) | undefined
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_issue_contexts') return [{ number: 42 }]
      if (command === 'start_background_investigation') {
        return new Promise(resolve => {
          finishStart = resolve
        })
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => expect(finishStart).toBeDefined())
    act(() => {
      queryClient.setQueryData<Worktree>(cacheKey, old => ({
        ...(old as Worktree),
        branch: 'updated-during-start',
      }))
    })
    act(() => {
      finishStart?.({
        sessionId: 'session-1',
        worktreeId: 'worktree-1',
        status: 'investigation_started',
      })
    })

    await waitFor(() => {
      expect(
        useUIStore.getState().autoInvestigateWorktreeIds.has('worktree-1')
      ).toBe(false)
    })

    act(() => {
      queryClient.setQueryData<Worktree>(cacheKey, old => ({
        ...(old as Worktree),
        branch: 'later-update',
      }))
    })
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === 'start_background_investigation'
        )
    ).toHaveLength(1)
  })

  it('starts investigation even when the worktree is already active/open', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData<Worktree>(
      [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
      {
        id: 'worktree-1',
        project_id: 'project-1',
        path: '/tmp/worktree-1',
        status: 'ready',
      } as Worktree
    )

    useChatStore.setState({
      activeWorktreeId: 'worktree-1',
      worktreePaths: { 'worktree-1': '/tmp/worktree-1' },
    })
    useUIStore.setState({
      autoInvestigateWorktreeIds: new Set(['worktree-1']),
      autoOpenSessionWorktreeIds: new Set(['worktree-1']),
    })

    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_issue_contexts') return [{ number: 42 }]
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.objectContaining({
          worktreeId: 'worktree-1',
          worktreePath: '/tmp/worktree-1',
          message: expect.stringContaining('#42'),
        })
      )
    })

    await waitFor(() => {
      expect(
        useUIStore.getState().autoInvestigateWorktreeIds.has('worktree-1')
      ).toBe(false)
    })
  })

  it('appends fix-after-investigation directive when mode is yolo', async () => {
    preferencesData = {
      magic_prompt_modes: {
        investigate_issue_mode: 'yolo',
      },
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData<Worktree>(
      [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
      {
        id: 'worktree-1',
        project_id: 'project-1',
        path: '/tmp/worktree-1',
        status: 'ready',
      } as Worktree
    )

    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_issue_contexts') return [{ number: 42 }]
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.objectContaining({
          executionMode: 'yolo',
          message: expect.stringContaining('<yolo_investigation_fix>'),
        })
      )
    })

    const call = vi
      .mocked(invoke)
      .mock.calls.find(
        ([command]) => command === 'start_background_investigation'
      )
    const args = call?.[1] as { message: string }
    expect(args.message).toContain('After investigation, fix the issue')
    expect(args.message).not.toMatch(/If you are in yolo mode/i)
    // Session toolbar mode must match the magic prompt mode, not the default
    await waitFor(() => {
      expect(useChatStore.getState().executionModes['session-1']).toBe('yolo')
    })
  })

  it('starts PR investigation when client status was wiped by a remote refetch', async () => {
    // get_worktree omits client-only `status`; after a remote refetch the cache
    // often has path + worktree data but no status field.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData<Worktree>(
      [...projectsQueryKeys.all, 'worktree', 'worktree-1'],
      {
        id: 'worktree-1',
        project_id: 'project-1',
        path: '/tmp/worktree-1',
        // status intentionally omitted — mirrors post-refetch remote cache
      } as Worktree
    )

    useUIStore.setState({
      autoInvestigateWorktreeIds: new Set(),
      autoInvestigatePRWorktreeIds: new Set(['worktree-1']),
    })

    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_pr_contexts') return [{ number: 99 }]
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'list_loaded_pr_contexts',
        expect.objectContaining({
          sessionId: 'worktree-1',
          worktreeId: 'worktree-1',
        })
      )
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.objectContaining({
          worktreeId: 'worktree-1',
          message: expect.stringContaining('#99'),
        })
      )
    })

    await waitFor(() => {
      expect(
        useUIStore.getState().autoInvestigatePRWorktreeIds.has('worktree-1')
      ).toBe(false)
    })
  })

  it('recovers path from list cache and starts PR investigation', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    // Single-worktree cache missing; list cache has the server-backed worktree
    // (typical after a missed worktree:created event + list recovery refetch).
    // worktreePaths is empty — path must be recovered from the list cache.
    queryClient.setQueryData<Worktree[]>(
      projectsQueryKeys.worktrees('project-1'),
      [
        {
          id: 'worktree-1',
          project_id: 'project-1',
          path: '/tmp/worktree-1',
          name: 'pr-99',
          branch: 'feature',
          created_at: 1,
          session_type: 'worktree',
          order: 0,
        } as Worktree,
      ]
    )
    useChatStore.setState({
      activeWorktreeId: null,
      worktreePaths: {},
    })
    useUIStore.setState({
      autoInvestigateWorktreeIds: new Set(),
      autoInvestigatePRWorktreeIds: new Set(['worktree-1']),
    })

    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_loaded_pr_contexts') return [{ number: 99 }]
      if (command === 'start_background_investigation') {
        return {
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          status: 'investigation_started',
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useBackgroundInvestigation(), { wrapper })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'start_background_investigation',
        expect.objectContaining({
          worktreeId: 'worktree-1',
          worktreePath: '/tmp/worktree-1',
          message: expect.stringContaining('#99'),
        })
      )
    })

    expect(useChatStore.getState().worktreePaths['worktree-1']).toBe(
      '/tmp/worktree-1'
    )
  })
})
