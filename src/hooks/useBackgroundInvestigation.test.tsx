import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
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
    })
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
      .mock.calls.find(([command]) => command === 'start_background_investigation')
    const args = call?.[1] as { message: string }
    expect(args.message).toContain('After investigation, fix the issue')
    expect(args.message).not.toMatch(/If you are in yolo mode/i)
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
    queryClient.setQueryData<Worktree[]>(projectsQueryKeys.worktrees('project-1'), [
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
    ])
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
