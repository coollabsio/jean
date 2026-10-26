import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
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

describe('useNewWorktreeHandlers duplicate guard', () => {
  const match = {
    worktreeId: 'wt-existing',
    worktreeName: 'fix-login',
    worktreePath: '/repo/fix-login',
  }

  function setup(
    getMatches: (ref: {
      type: string
      id: number | string
    }) => (typeof match)[],
    extra: Record<string, unknown> = {}
  ) {
    const createWorktree = { mutate: vi.fn(), mutateAsync: vi.fn() }
    const data = {
      selectedProjectId: 'project-1',
      selectedProject: { path: '/repo' },
      worktrees: [],
      baseSession: null,
      createWorktree,
      queryClient: { invalidateQueries: vi.fn() },
      ...extra,
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

  it('creates a worktree for the same issue number on a non-primary remote', async () => {
    const getMatches = vi.fn(() => [match])
    const { result, createWorktree } = setup(getMatches, {
      hasMultipleGitHubRemotes: true,
      primaryGitHubRemote: 'origin',
    })
    vi.mocked(invoke).mockResolvedValue({
      number: 42,
      title: 'Fork issue',
      body: 'from the fork',
      comments: [],
    } as never)

    await act(async () => {
      await result.current.handleSelectIssue({
        number: 42,
        title: 'Fork issue',
        remote: 'fork',
        repo: 'octocat/jean',
      } as GitHubIssue)
    })

    expect(openContextLinkMatch).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('get_github_issue', {
      projectPath: '/repo',
      issueNumber: 42,
      repo: 'octocat/jean',
    })
    expect(createWorktree.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        issueContext: expect.objectContaining({
          number: 42,
          repo: 'octocat/jean',
        }),
      })
    )
  })

  it('still reuses an existing worktree for the primary remote', async () => {
    const getMatches = vi.fn(() => [match])
    const { result } = setup(getMatches, {
      hasMultipleGitHubRemotes: true,
      primaryGitHubRemote: 'origin',
    })

    await act(async () => {
      await result.current.handleSelectIssue({
        number: 42,
        remote: 'origin',
        repo: 'coollabsio/jean',
      } as GitHubIssue)
    })

    expect(openContextLinkMatch).toHaveBeenCalledWith(match)
    expect(invoke).not.toHaveBeenCalled()
  })
})
