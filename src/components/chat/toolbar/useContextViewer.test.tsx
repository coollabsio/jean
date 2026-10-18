import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getIssueContextContent, getPRContextContent } from '@/services/github'
import { useContextViewer } from './useContextViewer'

vi.mock('@/services/github', () => ({
  getIssueContextContent: vi.fn(),
  getPRContextContent: vi.fn(),
}))

describe('useContextViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getIssueContextContent).mockResolvedValue('Issue context')
    vi.mocked(getPRContextContent).mockResolvedValue('PR context')
  })

  it('passes the worktree fallback when it opens issue and PR context', async () => {
    const { result } = renderHook(() =>
      useContextViewer({
        activeSessionId: 'session-1',
        worktreeId: 'worktree-1',
        activeWorktreePath: '/repo/worktree',
        projectId: 'project-1',
      })
    )

    await act(async () => {
      await result.current.handleViewIssue({
        number: 42,
        title: 'Issue',
        commentCount: 0,
        repoOwner: 'owner',
        repoName: 'repo',
      })
      await result.current.handleViewPR({
        number: 77,
        title: 'PR',
        commentCount: 0,
        reviewCount: 0,
        repoOwner: 'owner',
        repoName: 'repo',
      })
    })

    expect(getIssueContextContent).toHaveBeenCalledWith(
      'session-1',
      42,
      '/repo/worktree',
      'worktree-1'
    )
    expect(getPRContextContent).toHaveBeenCalledWith(
      'session-1',
      77,
      '/repo/worktree',
      'worktree-1'
    )
  })
})
