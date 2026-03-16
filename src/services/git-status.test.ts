import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import {
  gitStatusQueryKeys,
  setAppFocusState,
  setActiveWorktreeForPolling,
  setGitPollInterval,
  getGitPollInterval,
  triggerImmediateGitPoll,
  gitPull,
  getGitRemotes,
  setRemotePollInterval,
  getRemotePollInterval,
  triggerImmediateRemotePoll,
  getGitDiff,
  useGitStatus,
  type WorktreePollingInfo,
} from './git-status'

const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/services/projects', () => ({
  isTauri: vi.fn(() => true),
  updateWorktreeCachedStatus: vi.fn(),
}))

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

const createWrapper = (queryClient: QueryClient) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  Wrapper.displayName = 'TestQueryClientWrapper'
  return Wrapper
}

describe('git-status service', () => {
  let queryClient: QueryClient

  beforeEach(async () => {
    queryClient = createTestQueryClient()
    vi.clearAllMocks()
    // Mock Tauri environment
    const { isTauri } = vi.mocked(await import('@/services/projects'))
    isTauri.mockReturnValue(true)
  })

  afterEach(() => {
    queryClient.clear()
  })

  describe('gitStatusQueryKeys', () => {
    it('returns correct all key', () => {
      expect(gitStatusQueryKeys.all).toEqual(['git-status'])
    })

    it('returns correct worktree key', () => {
      expect(gitStatusQueryKeys.worktree('wt-123')).toEqual([
        'git-status',
        'wt-123',
      ])
    })
  })

  describe('setAppFocusState', () => {
    it('calls invoke with focused state', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await setAppFocusState(true)

      expect(mockInvoke).toHaveBeenCalledWith('set_app_focus_state', {
        focused: true,
      })
    })

    it('skips when not in Tauri', async () => {
      const { isTauri } = vi.mocked(await import('@/services/projects'))
      isTauri.mockReturnValue(false)

      await setAppFocusState(true)

      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  describe('setActiveWorktreeForPolling', () => {
    it('calls invoke with worktree info', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      const info: WorktreePollingInfo = {
        worktreeId: 'wt-123',
        worktreePath: '/path/to/worktree',
        baseBranch: 'main',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
      }

      await setActiveWorktreeForPolling(info)

      expect(mockInvoke).toHaveBeenCalledWith(
        'set_active_worktree_for_polling',
        {
          worktreeId: 'wt-123',
          worktreePath: '/path/to/worktree',
          baseBranch: 'main',
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
        }
      )
    })

    it('calls invoke with nulls when clearing', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await setActiveWorktreeForPolling(null)

      expect(mockInvoke).toHaveBeenCalledWith(
        'set_active_worktree_for_polling',
        {
          worktreeId: null,
          worktreePath: null,
          baseBranch: null,
          prNumber: null,
          prUrl: null,
        }
      )
    })

    it('defaults prNumber and prUrl to null', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      const info: WorktreePollingInfo = {
        worktreeId: 'wt-123',
        worktreePath: '/path/to/worktree',
        baseBranch: 'main',
      }

      await setActiveWorktreeForPolling(info)

      expect(mockInvoke).toHaveBeenCalledWith(
        'set_active_worktree_for_polling',
        {
          worktreeId: 'wt-123',
          worktreePath: '/path/to/worktree',
          baseBranch: 'main',
          prNumber: null,
          prUrl: null,
        }
      )
    })
  })

  describe('setGitPollInterval', () => {
    it('calls invoke with seconds', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await setGitPollInterval(30)

      expect(mockInvoke).toHaveBeenCalledWith('set_git_poll_interval', {
        seconds: 30,
      })
    })
  })

  describe('getGitPollInterval', () => {
    it('returns interval from backend', async () => {
      mockInvoke.mockResolvedValueOnce(45)

      const result = await getGitPollInterval()

      expect(result).toBe(45)
      expect(mockInvoke).toHaveBeenCalledWith('get_git_poll_interval')
    })

    it('returns default when not in Tauri', async () => {
      const { isTauri } = vi.mocked(await import('@/services/projects'))
      isTauri.mockReturnValue(false)

      const result = await getGitPollInterval()

      expect(result).toBe(60)
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  describe('triggerImmediateGitPoll', () => {
    it('calls invoke', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await triggerImmediateGitPoll()

      expect(mockInvoke).toHaveBeenCalledWith('trigger_immediate_git_poll')
    })
  })

  describe('gitPull', () => {
    it('calls invoke and returns output', async () => {
      mockInvoke.mockResolvedValueOnce('Already up to date.')

      const result = await gitPull('/path/to/repo', 'main')

      expect(result).toBe('Already up to date.')
      expect(mockInvoke).toHaveBeenCalledWith('git_pull', {
        worktreePath: '/path/to/repo',
        baseBranch: 'main',
        remote: null,
      })
    })

    it('throws when not in Tauri', async () => {
      const { isTauri } = vi.mocked(await import('@/services/projects'))
      isTauri.mockReturnValue(false)

      await expect(gitPull('/path', 'main')).rejects.toThrow(
        'Git pull only available in Tauri'
      )
    })
  })

  describe('setRemotePollInterval', () => {
    it('calls invoke with seconds', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await setRemotePollInterval(120)

      expect(mockInvoke).toHaveBeenCalledWith('set_remote_poll_interval', {
        seconds: 120,
      })
    })
  })

  describe('getGitRemotes', () => {
    it('returns remotes with origin first', async () => {
      mockInvoke.mockResolvedValueOnce([
        { name: 'upstream' },
        { name: 'origin' },
        { name: 'fork' },
      ])

      const result = await getGitRemotes('/path/to/repo')

      expect(result).toEqual([
        { name: 'origin' },
        { name: 'upstream' },
        { name: 'fork' },
      ])
      expect(mockInvoke).toHaveBeenCalledWith('get_git_remotes', {
        repoPath: '/path/to/repo',
      })
    })

    it('keeps order unchanged when origin is missing', async () => {
      mockInvoke.mockResolvedValueOnce([{ name: 'upstream' }, { name: 'fork' }])

      const result = await getGitRemotes('/path/to/repo')

      expect(result).toEqual([{ name: 'upstream' }, { name: 'fork' }])
    })
  })

  describe('getRemotePollInterval', () => {
    it('returns interval from backend', async () => {
      mockInvoke.mockResolvedValueOnce(90)

      const result = await getRemotePollInterval()

      expect(result).toBe(90)
    })

    it('returns default when not in Tauri', async () => {
      const { isTauri } = vi.mocked(await import('@/services/projects'))
      isTauri.mockReturnValue(false)

      const result = await getRemotePollInterval()

      expect(result).toBe(60)
    })
  })

  describe('triggerImmediateRemotePoll', () => {
    it('calls invoke', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await triggerImmediateRemotePoll()

      expect(mockInvoke).toHaveBeenCalledWith('trigger_immediate_remote_poll')
    })
  })

  describe('getGitDiff', () => {
    it('calls invoke with uncommitted diff type', async () => {
      const mockDiff = {
        files: [],
        summary: { total_additions: 0, total_deletions: 0 },
      }
      mockInvoke.mockResolvedValueOnce(mockDiff)

      const result = await getGitDiff('/path/to/repo', 'uncommitted')

      expect(result).toEqual(mockDiff)
      expect(mockInvoke).toHaveBeenCalledWith('get_git_diff', {
        worktreePath: '/path/to/repo',
        diffType: 'uncommitted',
        baseBranch: undefined,
      })
    })

    it('calls invoke with branch diff type and base branch', async () => {
      const mockDiff = {
        files: [],
        summary: { total_additions: 10, total_deletions: 5 },
      }
      mockInvoke.mockResolvedValueOnce(mockDiff)

      const result = await getGitDiff('/path/to/repo', 'branch', 'main')

      expect(result).toEqual(mockDiff)
      expect(mockInvoke).toHaveBeenCalledWith('get_git_diff', {
        worktreePath: '/path/to/repo',
        diffType: 'branch',
        baseBranch: 'main',
      })
    })

    it('throws when not in Tauri', async () => {
      const { isTauri } = vi.mocked(await import('@/services/projects'))
      isTauri.mockReturnValue(false)

      await expect(getGitDiff('/path', 'uncommitted')).rejects.toThrow(
        'Git diff only available in Tauri'
      )
    })
  })

  describe('useGitStatus', () => {
    it('returns null data when no worktree ID', async () => {
      const { result } = renderHook(() => useGitStatus(null), {
        wrapper: createWrapper(queryClient),
      })

      // Query should be disabled
      expect(result.current.data).toBeUndefined()
      expect(result.current.fetchStatus).toBe('idle')
    })

    it('returns cached status for worktree', async () => {
      // Pre-populate cache
      queryClient.setQueryData(gitStatusQueryKeys.worktree('wt-123'), {
        worktree_id: 'wt-123',
        behind_count: 5,
        ahead_count: 2,
      })

      const { result } = renderHook(() => useGitStatus('wt-123'), {
        wrapper: createWrapper(queryClient),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(result.current.data?.behind_count).toBe(5)
      expect(result.current.data?.ahead_count).toBe(2)
    })
  })
})
