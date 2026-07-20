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

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
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
})
