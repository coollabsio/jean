import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { GitHubIssue } from '@/types/github'
import { useNewWorktreeHandlers } from './useNewWorktreeHandlers'
import { openContextLinkMatch } from '@/hooks/useContextLinkUsage'
import { toast } from 'sonner'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))
vi.mock('@/hooks/useContextLinkUsage', () => ({
  openContextLinkMatch: vi.fn(),
  contextLinkMatchLabel: (match: { worktreeName: string }) =>
    match.worktreeName,
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
  }),
}))

describe('useNewWorktreeHandlers current-worktree issue investigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ activeWorktreeId: null, worktreePaths: {} })
    useProjectsStore.setState({ selectedWorktreeId: 'worktree-1' })
    useUIStore.setState({ autoInvestigateOverrides: {} })
  })

  it('sends the selected issue context to the new session workflow', async () => {
    vi.mocked(invoke).mockResolvedValue({
      number: 42,
      title: 'Fix login',
      body: 'The login fails',
      comments: [
        {
          body: 'Please fix this',
          author: { login: 'reporter' },
          created_at: '2026-01-01',
        },
      ],
    } as never)

    const data = {
      selectedProjectId: 'project-1',
      selectedProject: { path: '/repo' },
      worktrees: [
        { id: 'worktree-1', project_id: 'project-1', path: '/repo/worktree' },
      ],
      baseSession: null,
    } as unknown as Parameters<typeof useNewWorktreeHandlers>[0]
    const setters = {
      setActiveTab: vi.fn(),
      setSearchQuery: vi.fn(),
      setSelectedItemIndex: vi.fn(),
      setIncludeClosed: vi.fn(),
    }
    const { result } = renderHook(() => useNewWorktreeHandlers(data, setters))

    await act(async () => {
      await result.current.handleInvestigateIssueInNewSession({
        number: 42,
      } as GitHubIssue)
    })

    expect(
      useUIStore.getState().autoInvestigateOverrides['worktree-1']
    ).toEqual(
      expect.objectContaining({
        forceNewSession: true,
        issueContext: {
          number: 42,
          title: 'Fix login',
          body: 'The login fails',
          comments: [
            {
              body: 'Please fix this',
              author: { login: 'reporter' },
              createdAt: '2026-01-01',
            },
          ],
        },
      })
    )
  })
})

describe('useNewWorktreeHandlers duplicate guard', () => {
  const match = {
    worktreeId: 'wt-existing',
    worktreeName: 'fix-login',
    worktreePath: '/repo/fix-login',
  }

  function setup(
    getMatches: (ref: { type: string; id: number | string }) => (typeof match)[]
  ) {
    const createWorktree = { mutate: vi.fn(), mutateAsync: vi.fn() }
    const data = {
      selectedProjectId: 'project-1',
      selectedProject: { path: '/repo' },
      worktrees: [],
      baseSession: null,
      createWorktree,
      queryClient: { invalidateQueries: vi.fn() },
    } as unknown as Parameters<typeof useNewWorktreeHandlers>[0]
    const setters = {
      setActiveTab: vi.fn(),
      setSearchQuery: vi.fn(),
      setSelectedItemIndex: vi.fn(),
      setIncludeClosed: vi.fn(),
    }
    const { result } = renderHook(() =>
      useNewWorktreeHandlers(data, setters, undefined, getMatches)
    )
    return { result, createWorktree }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({ newWorktreeModalOpen: true })
  })

  it('opens the existing worktree instead of creating one for a matched issue', async () => {
    const getMatches = vi.fn(() => [match])
    const { result, createWorktree } = setup(getMatches)

    await act(async () => {
      await result.current.handleSelectIssue({ number: 42 } as GitHubIssue)
    })

    expect(getMatches).toHaveBeenCalledWith({ type: 'issue', id: 42 })
    expect(openContextLinkMatch).toHaveBeenCalledWith(match)
    expect(invoke).not.toHaveBeenCalled()
    expect(createWorktree.mutate).not.toHaveBeenCalled()
    expect(useUIStore.getState().newWorktreeModalOpen).toBe(false)
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining('Issue #42 already has a worktree')
    )
  })

  it('skips matched items in bulk investigate', async () => {
    const getMatches = vi.fn((ref: { id: number | string }) =>
      ref.id === 1 ? [match] : []
    )
    const { result, createWorktree } = setup(getMatches)
    vi.mocked(invoke).mockResolvedValue({ number: 2, title: 't' } as never)
    createWorktree.mutateAsync.mockResolvedValue({ id: 'wt-new' })

    await act(async () => {
      await result.current.handleBulkInvestigateIssues([
        { number: 1 },
        { number: 2 },
      ] as GitHubIssue[])
    })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('get_github_issue', {
      projectPath: '/repo',
      issueNumber: 2,
    })
    expect(toast.info).toHaveBeenCalledWith(
      'Skipped 1 item that already has a worktree'
    )
    expect(openContextLinkMatch).not.toHaveBeenCalled()
  })
})
