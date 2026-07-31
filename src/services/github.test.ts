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
  getAdvisoryContextContent,
  isGhAuthError,
  isUnsupportedGitHubRepoError,
  sessionReferenceSlug,
} from './github'

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
