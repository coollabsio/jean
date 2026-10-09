import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useContextLinkUsage } from './useContextLinkUsage'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({ invoke: mockInvoke }))

vi.mock('@/services/projects', () => ({
  useWorktrees: () => ({
    data: [
      { id: 'wt-a', name: 'fix-login', path: '/wt/a', issue_number: 12 },
      { id: 'wt-b', name: 'feature', path: '/wt/b' },
      {
        id: 'wt-old',
        name: 'old',
        path: '/wt/old',
        archived_at: 1,
        issue_number: 12,
      },
    ],
  }),
}))

vi.mock('@/services/chat', () => ({
  useAllSessions: () => ({
    data: {
      entries: [
        {
          project_id: 'p1',
          worktree_id: 'wt-a',
          sessions: [{ id: 's-a1', name: 'Investigate #12' }],
        },
        {
          project_id: 'p1',
          worktree_id: 'wt-b',
          sessions: [
            { id: 's-b1', name: 'Chat' },
            { id: 's-b2', name: 'Archived', archived_at: 1 },
          ],
        },
      ],
    },
  }),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useContextLinkUsage', () => {
  it('merges worktree links and session refs, one match per worktree', async () => {
    mockInvoke.mockResolvedValue({
      issues: { '12': ['s-a1', 'stale-session'], '30': ['s-b2'] },
      prs: { '7': ['wt-b', 's-b1'] },
      security: {},
      advisories: {},
      linear: { 'ENG-1': ['s-b1'] },
    })

    const { result } = renderHook(
      () =>
        useContextLinkUsage({
          enabled: true,
          projectId: 'p1',
          projectPath: '/repo',
        }),
      { wrapper }
    )

    await waitFor(() =>
      expect(result.current.getMatches({ type: 'pr', id: 7 })).toHaveLength(1)
    )
    // Worktree link + session ref collapse into the session match
    expect(result.current.getMatches({ type: 'issue', id: 12 })).toEqual([
      {
        worktreeId: 'wt-a',
        worktreeName: 'fix-login',
        worktreePath: '/wt/a',
        sessionId: 's-a1',
        sessionName: 'Investigate #12',
      },
    ])
    expect(result.current.getMatches({ type: 'pr', id: 7 })[0]?.sessionId).toBe(
      's-b1'
    )
    // Archived sessions do not count
    expect(result.current.getMatches({ type: 'issue', id: 30 })).toEqual([])
    // Linear identifiers match case-insensitively
    expect(
      result.current.getMatches({ type: 'linear', id: 'eng-1' })
    ).toHaveLength(1)
  })

  it('ignores the current session and its worktree link', async () => {
    mockInvoke.mockResolvedValue({
      issues: { '12': ['s-a1'] },
      prs: {},
      security: {},
      advisories: {},
      linear: {},
    })

    const { result } = renderHook(
      () =>
        useContextLinkUsage({
          enabled: true,
          projectId: 'p1',
          projectPath: '/repo',
          currentSessionId: 's-a1',
        }),
      { wrapper }
    )

    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    expect(result.current.getMatches({ type: 'issue', id: 12 })).toEqual([])
  })
})
