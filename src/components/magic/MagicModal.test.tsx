import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { MagicModal } from './MagicModal'

const mocks = vi.hoisted(() => {
  const worktree = {
    id: 'wt-1',
    project_id: 'project-1',
    name: 'feature',
    path: '/repo/worktree',
    branch: 'feature-branch',
    pr_number: null as number | null,
    pr_url: null as string | null,
  }
  return {
    setMagicModalOpen: vi.fn(),
    selectWorktree: vi.fn(),
    invokeMock: vi.fn(),
    invalidateQueries: vi.fn(),
    triggerImmediateGitPoll: vi.fn(),
    fetchWorktreesStatus: vi.fn(),
    setActiveSession: vi.fn(),
    registerWorktreePath: vi.fn(),
    setSelectedBackend: vi.fn(),
    setSelectedModel: vi.fn(),
    setSelectedProvider: vi.fn(),
    setExecutionMode: vi.fn(),
    setExecutingMode: vi.fn(),
    setLastSentMessage: vi.fn(),
    setError: vi.fn(),
    clearInputDraft: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    openExternal: vi.fn(),
    worktree,
  }
})

interface UiState {
  magicModalOpen: boolean
  setMagicModalOpen: typeof mocks.setMagicModalOpen
  sessionChatModalWorktreeId: string | null
  sessionChatModalOpen: boolean
  setUpdatePrModalOpen: ReturnType<typeof vi.fn>
  setReviewCommentsModalOpen: ReturnType<typeof vi.fn>
  setReleaseNotesModalOpen: ReturnType<typeof vi.fn>
  setLinkedProjectsModalOpen: ReturnType<typeof vi.fn>
}

interface ProjectsState {
  selectedWorktreeId: string
  selectedProjectId: string
}

interface ChatState {
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  activeSessionIds: Record<string, string>
}

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    (selector?: (state: UiState) => unknown) => {
      const state: UiState = {
        magicModalOpen: true,
        setMagicModalOpen: mocks.setMagicModalOpen,
        sessionChatModalWorktreeId: null,
        sessionChatModalOpen: false,
        setUpdatePrModalOpen: vi.fn(),
        setReviewCommentsModalOpen: vi.fn(),
        setReleaseNotesModalOpen: vi.fn(),
        setLinkedProjectsModalOpen: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        setUpdatePrModalOpen: vi.fn(),
        setReviewCommentsModalOpen: vi.fn(),
        setReleaseNotesModalOpen: vi.fn(),
        setLinkedProjectsModalOpen: vi.fn(),
      }),
    }
  ),
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: Object.assign(
    (selector?: (state: ProjectsState) => unknown) => {
      const state: ProjectsState = {
        selectedWorktreeId: 'wt-1',
        selectedProjectId: 'project-1',
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ selectWorktree: mocks.selectWorktree }) }
  ),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: Object.assign(
    (selector?: (state: ChatState) => unknown) => {
      const state: ChatState = {
        activeWorktreeId: null,
        activeWorktreePath: null,
        activeSessionIds: {},
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        activeWorktreePath: null,
        activeSessionIds: {},
        setWorktreeLoading: vi.fn(),
        clearWorktreeLoading: vi.fn(),
        setActiveWorktree: vi.fn(),
        setPendingMagicCommand: vi.fn(),
        registerWorktreePath: mocks.registerWorktreePath,
        setActiveSession: mocks.setActiveSession,
        setSelectedBackend: mocks.setSelectedBackend,
        setSelectedModel: mocks.setSelectedModel,
        setSelectedProvider: mocks.setSelectedProvider,
        setExecutionMode: mocks.setExecutionMode,
        setExecutingMode: mocks.setExecutingMode,
        setLastSentMessage: mocks.setLastSentMessage,
        setError: mocks.setError,
        clearInputDraft: mocks.clearInputDraft,
        copySessionSettings: vi.fn(),
      }),
    }
  ),
}))

vi.mock('@/services/projects', () => ({
  useWorktree: () => ({ data: mocks.worktree }),
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        name: 'Project',
        path: '/repo',
        default_branch: 'main',
      },
    ],
  }),
  saveWorktreePr: vi.fn(),
  linkWorktreePr: (
    worktreeId: string,
    worktreePath: string,
    prNumber: number
  ) =>
    mocks.invokeMock('link_worktree_pr', {
      worktreeId,
      worktreePath,
      prNumber,
    }),
  projectsQueryKeys: {
    worktrees: (projectId: string) => ['projects', projectId, 'worktrees'],
    all: ['projects'],
  },
}))

vi.mock('@/services/github', () => ({
  useLoadedIssueContexts: () => ({ data: [] }),
  useLoadedPRContexts: () => ({ data: [] }),
  useLoadedAdvisoryContexts: () => ({ data: [] }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      default_backend: 'claude',
      selected_codex_model: 'gpt-5.5',
      magic_prompt_backends: { resolve_conflicts_backend: 'codex' },
      magic_prompts: { resolve_conflicts: 'Resolve and finish.' },
    },
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: [] }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: ['claude'] }),
}))

vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => vi.fn(),
}))

vi.mock('@/services/git-status', () => ({
  triggerImmediateGitPoll: mocks.triggerImmediateGitPoll,
  fetchWorktreesStatus: mocks.fetchWorktreesStatus,
  gitPush: vi.fn(),
  performGitPull: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invokeMock }))
vi.mock('@/lib/platform', () => ({
  openExternal: mocks.openExternal,
  isMacOS: false,
  isWindows: false,
  isLinux: true,
  getServerPlatform: vi.fn(() => 'linux'),
  isServerWindows: vi.fn(() => false),
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal()),
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: vi.fn(),
  }),
}))
vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    loading: vi.fn(() => 'toast-1'),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/components/chat/ReviewMethodModal', () => ({
  ReviewMethodModal: () => null,
}))

describe('MagicModal manual PR link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.worktree.pr_number = null
    mocks.worktree.pr_url = null
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'detect_and_link_pr') return Promise.resolve(null)
      if (command === 'link_worktree_pr') {
        return Promise.resolve({
          pr_number: 123,
          pr_url: 'https://github.com/o/r/pull/123',
          title: 'Fix bug',
        })
      }
      return Promise.resolve(null)
    })
  })

  it('opens a Link PR dialog and shows checking state while searching current branch', async () => {
    const user = userEvent.setup()
    let resolveDetection:
      | ((value: { pr_number: number; pr_url: string; title: string }) => void)
      | undefined
    const detectionPromise = new Promise<{
      pr_number: number
      pr_url: string
      title: string
    }>(resolve => {
      resolveDetection = resolve
    })
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'detect_and_link_pr') {
        return detectionPromise
      }
      return Promise.resolve(null)
    })

    render(<MagicModal />)

    await user.click(screen.getByRole('button', { name: /link pr/i }))

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith('detect_and_link_pr', {
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
      })
    })
    expect(
      screen.getByText(/Checking current branch for an open PR/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/pr number/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /^checking/i })).toBeDisabled()

    if (!resolveDetection) throw new Error('Detection resolver not set')
    resolveDetection({
      pr_number: 456,
      pr_url: 'https://github.com/o/r/pull/456',
      title: 'Existing branch PR',
    })

    expect(await screen.findByDisplayValue('456')).toBeInTheDocument()
    expect(
      screen.getByText(/Found PR #456: Existing branch PR/i)
    ).toBeInTheDocument()
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['projects', 'project-1', 'worktrees'],
    })
  })

  it('opens a Link PR dialog and links the selected PR number', async () => {
    const user = userEvent.setup()
    render(<MagicModal />)

    await user.click(screen.getByRole('button', { name: /link pr/i }))
    await user.type(screen.getByLabelText(/pr number/i), '123')
    await user.click(screen.getByRole('button', { name: /^link pr$/i }))

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith('link_worktree_pr', {
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        prNumber: 123,
      })
    })
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['projects', 'project-1', 'worktrees'],
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Linked PR #123: Fix bug',
      expect.any(Object)
    )
  })

  it('sends resolve conflicts immediately in yolo from the direct canvas dialog', async () => {
    const user = userEvent.setup()
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch',
        })
      }
      if (command === 'create_session') {
        return Promise.resolve({
          id: 'conflict-session',
          name: 'Resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        })
      }
      if (command === 'send_chat_message') {
        return Promise.resolve({ id: 'message-1' })
      }
      return Promise.resolve(undefined)
    })

    render(<MagicModal />)

    await user.click(screen.getByRole('button', { name: /resolve conflicts/i }))
    await user.click(
      screen.getByRole('button', { name: /^resolve conflicts$/i })
    )

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith(
        'send_chat_message',
        expect.objectContaining({
          sessionId: 'conflict-session',
          worktreeId: 'wt-1',
          worktreePath: '/repo/worktree',
          model: 'gpt-5.5',
          executionMode: 'yolo',
          backend: 'codex',
        })
      )
    })
    const sendCall = mocks.invokeMock.mock.calls.find(
      call => call[0] === 'send_chat_message'
    )
    expect(sendCall?.[1].message).toContain(
      'I have merge conflicts that need to be resolved.'
    )
    expect(sendCall?.[1].message).toContain('Resolve and finish.')
    expect(mocks.setExecutionMode).toHaveBeenCalledWith(
      'conflict-session',
      'yolo'
    )
  })

  it('sends resolve conflicts immediately in yolo from the keyboard shortcut', async () => {
    const user = userEvent.setup()
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch',
        })
      }
      if (command === 'create_session') {
        return Promise.resolve({
          id: 'keyboard-conflict-session',
          name: 'Resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        })
      }
      if (command === 'send_chat_message') {
        return Promise.resolve({ id: 'message-1' })
      }
      return Promise.resolve(undefined)
    })

    render(<MagicModal />)

    await user.keyboard('f')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith(
        'send_chat_message',
        expect.objectContaining({
          sessionId: 'keyboard-conflict-session',
          executionMode: 'yolo',
          backend: 'codex',
        })
      )
    })
  })

  it('uses the PR conflict flow from magic when local conflicts are not present yet', async () => {
    const user = userEvent.setup()
    mocks.worktree.pr_number = 31
    mocks.worktree.pr_url = 'https://github.com/o/r/pull/31'
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: false,
          conflicts: [],
          conflict_diff: '',
        })
      }
      if (command === 'fetch_and_merge_base') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/pr-file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main',
        })
      }
      if (command === 'create_session') {
        return Promise.resolve({
          id: 'pr-conflict-session',
          name: 'PR: resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        })
      }
      if (command === 'send_chat_message') {
        return Promise.resolve({ id: 'message-1' })
      }
      return Promise.resolve(undefined)
    })

    render(<MagicModal />)

    await user.click(screen.getByRole('button', { name: /resolve conflicts/i }))
    await user.click(
      screen.getByRole('button', { name: /^resolve conflicts$/i })
    )

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith('fetch_and_merge_base', {
        worktreeId: 'wt-1',
      })
      expect(mocks.invokeMock).toHaveBeenCalledWith(
        'send_chat_message',
        expect.objectContaining({
          sessionId: 'pr-conflict-session',
          executionMode: 'yolo',
          backend: 'codex',
        })
      )
    })
    const sendCall = mocks.invokeMock.mock.calls.find(
      call => call[0] === 'send_chat_message'
    )
    expect(sendCall?.[1].message).toContain(
      'I merged `origin/main` into this branch to resolve PR conflicts'
    )
  })

  it('asks for confirmation before reverting the last commit from the magic option', async () => {
    const user = userEvent.setup()
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'revert_last_local_commit') {
        return Promise.resolve({
          commit_hash: 'abc123',
          commit_message: 'Test commit',
        })
      }
      return Promise.resolve(null)
    })

    render(<MagicModal />)

    await user.click(screen.getByRole('button', { name: /revert commit/i }))

    expect(
      screen.getByRole('alertdialog', { name: /revert last commit/i })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/This will undo the latest local commit/i)
    ).toBeInTheDocument()
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      'revert_last_local_commit',
      expect.anything()
    )

    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(
      screen.queryByRole('alertdialog', { name: /revert last commit/i })
    ).not.toBeInTheDocument()
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      'revert_last_local_commit',
      expect.anything()
    )
  })

  it('does not show the removed release post action', () => {
    render(<MagicModal />)

    expect(screen.queryByRole('button', { name: /release post/i })).toBeNull()
  })

  it('shows the fork session magic command', () => {
    render(<MagicModal />)

    expect(
      screen.getByRole('button', { name: /fork session/i })
    ).toBeInTheDocument()
  })

  it('reverts the last commit only after confirmation', async () => {
    const user = userEvent.setup()
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'revert_last_local_commit') {
        return Promise.resolve({
          commit_hash: 'abc123',
          commit_message: 'Test commit',
        })
      }
      return Promise.resolve(null)
    })

    render(<MagicModal />)

    await user.keyboard('z')
    await user.click(
      screen.getByRole('button', { name: /^revert last commit$/i })
    )

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith(
        'revert_last_local_commit',
        { worktreePath: '/repo/worktree' }
      )
    })
    expect(
      mocks.invokeMock.mock.calls.filter(
        call => call[0] === 'revert_last_local_commit'
      )
    ).toHaveLength(1)
    expect(mocks.triggerImmediateGitPoll).toHaveBeenCalled()
    expect(mocks.fetchWorktreesStatus).toHaveBeenCalledWith('project-1')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Reverted: Test commit', {
      id: 'toast-1',
    })
  })
})
