import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('./projects', () => ({
  isTauri: () => true,
}))

import {
  attachSessionReference,
  filterDiscussions,
  filterIssues,
  githubItemKey,
  getAdvisoryContextContent,
  isGhAuthError,
  isUnsupportedGitHubRepoError,
  mergeWithSearchResults,
  prependExactMatches,
  sessionReferenceSlug,
} from './github'
import type { GitHubDiscussion, GitHubIssue } from '@/types/github'

describe('GitHub issue search', () => {
  const issues: GitHubIssue[] = [
    {
      number: 1,
      title: 'Login fails',
      body: 'The sign-in button stays disabled',
      state: 'open',
      labels: [],
      created_at: '2026-01-01',
      author: { login: 'alice' },
    },
    {
      number: 2,
      title: 'Improve navigation',
      body: 'Update the project list',
      state: 'open',
      labels: [],
      created_at: '2026-01-01',
      author: { login: 'bob' },
    },
  ]

  it('keeps the same issue number distinct across repositories', () => {
    const base = issues[0]
    if (!base) throw new Error('missing issue fixture')
    const origin: GitHubIssue = {
      ...base,
      repo: 'coollabsio/jean',
      remote: 'origin',
    }
    const fork: GitHubIssue = {
      ...base,
      title: 'Fork copy',
      repo: 'octocat/jean',
      remote: 'fork',
    }
    expect(githubItemKey(origin)).not.toBe(githubItemKey(fork))
    expect(mergeWithSearchResults([origin], [fork, origin])).toEqual([
      origin,
      fork,
    ])
    expect(prependExactMatches([origin], [fork])).toEqual([fork, origin])
    expect(filterIssues([origin, fork], 'octocat')).toEqual([fork])
  })

  it('matches issue titles and descriptions', () => {
    expect(filterIssues(issues, 'login fails')).toEqual([issues[0]])
    expect(filterIssues(issues, 'button stays disabled')).toEqual([issues[0]])
    expect(filterIssues(issues, 'project list')).toEqual([issues[1]])
  })
})

describe('GitHub discussion search', () => {
  const discussion = (
    number: number,
    title: string,
    body: string,
    category: string | null
  ): GitHubDiscussion => ({
    number,
    title,
    body,
    url: `https://github.com/o/r/discussions/${number}`,
    closed: false,
    isAnswered: false,
    author: null,
    category: category ? { name: category, emoji: '' } : null,
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })
  const discussions = [
    discussion(12, 'Roadmap for v2', 'What ships next', 'Ideas'),
    discussion(34, 'Install fails on Windows', 'PATH error', 'Q&A'),
    discussion(56, 'Uncategorized thread', 'hello', null),
  ]
  const numbers = (query: string) =>
    filterDiscussions(discussions, query).map(d => d.number)

  it('returns every discussion for a blank query', () => {
    expect(numbers('  ')).toEqual([12, 34, 56])
  })

  it('matches number with or without #, title, body, and category', () => {
    expect(numbers('#34')).toEqual([34])
    expect(numbers('roadmap')).toEqual([12])
    expect(numbers('path error')).toEqual([34])
    expect(numbers('q&a')).toEqual([34])
  })

  it('skips the category check when a discussion has none', () => {
    expect(numbers('ideas')).toEqual([12])
  })
})

describe('GitHub service error classification', () => {
  it('does not treat unknown GitHub host remotes as auth errors', () => {
    const error =
      'none of the git remotes configured for this repository point to a known GitHub host.\n' +
      'To tell gh about a new GitHub host, please use `gh auth login`'

    expect(isUnsupportedGitHubRepoError(error)).toBe(true)
    expect(isGhAuthError(error)).toBe(false)
  })

  it('does not treat missing git remotes as auth errors', () => {
    const error = 'no git remotes found'

    expect(isUnsupportedGitHubRepoError(error)).toBe(true)
    expect(isGhAuthError(error)).toBe(false)
  })

  it('detects raw GitHub CLI auth prompts after excluding repo eligibility errors', () => {
    expect(
      isGhAuthError('To get started with GitHub CLI, please run: gh auth login')
    ).toBe(true)
  })

  it('detects standardized GitHub CLI auth errors', () => {
    expect(
      isGhAuthError("GitHub CLI not authenticated. Run 'gh auth login' first.")
    ).toBe(true)
  })
})

describe('github advisory context service', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('passes worktreeId when fetching advisory context content', async () => {
    mockInvoke.mockResolvedValueOnce('# Security Advisory GHSA-test')

    await getAdvisoryContextContent(
      'session-1',
      'GHSA-892v-qq52-xprh',
      '/repo/worktree',
      'wt-1'
    )

    expect(mockInvoke).toHaveBeenCalledWith('get_advisory_context_content', {
      sessionId: 'session-1',
      ghsaId: 'GHSA-892v-qq52-xprh',
      projectPath: '/repo/worktree',
      worktreeId: 'wt-1',
    })
  })
})

describe('session reference injection', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('builds stable session-ref slugs', () => {
    expect(sessionReferenceSlug('abc-123')).toBe('session-ref-abc-123')
  })

  it('invokes attach_session_reference with camelCase args', async () => {
    mockInvoke.mockResolvedValueOnce({
      slug: 'session-ref-src-1',
      name: 'Session: Fix login',
      size: 100,
      createdAt: 1,
    })

    await attachSessionReference(
      'target-session',
      'src-1',
      'Fix login',
      'jean',
      'issue-596'
    )

    expect(mockInvoke).toHaveBeenCalledWith('attach_session_reference', {
      targetSessionId: 'target-session',
      sourceSessionId: 'src-1',
      sessionName: 'Fix login',
      projectName: 'jean',
      worktreeName: 'issue-596',
    })
  })
})
