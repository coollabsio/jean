import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { WorktreeItem } from './WorktreeItem'

const mocks = vi.hoisted(() => ({
  sessions: [] as {
    id: string
    name: string
    messages: []
    message_count?: number
  }[],
  archive: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => vi.fn(),
  pushNeedsRemotePicker: () => false,
}))
vi.mock('@/components/layout/SidebarWidthContext', () => ({
  useSidebarWidth: () => 320,
}))
vi.mock('@/hooks/useWorktreeTerminalStatus', () => ({
  TerminalStatusIndicator: () => null,
}))
vi.mock('@/services/git-status', () => ({
  useGitStatus: () => ({ data: null }),
}))
vi.mock('@/services/chat', () => ({
  useSessions: () => ({ data: { sessions: mocks.sessions } }),
  useRenameSession: () => ({ mutate: mocks.rename }),
  useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
  canReconnectSession: () => false,
  reconnectNativeCliSession: vi.fn(),
}))
vi.mock('@/services/projects', () => ({
  useRenameWorktree: () => ({ mutate: vi.fn() }),
  useWorktrees: () => ({
    data: [
      { id: 'wt-1', origin: 'manual' },
      { id: 'wt-2', origin: 'manual' },
    ],
  }),
}))
vi.mock('@/components/chat/hooks/useCanvasStoreState', () => ({
  useCanvasStoreState: () => ({}),
}))
vi.mock('@/components/chat/session-card-utils', () => ({
  createSessionCardDataCache: () => (session: unknown) => ({
    session,
    status: 'idle',
  }),
  groupCardsByStatus: (cards: unknown[]) => [
    { key: 'idle', title: 'Idle', indicatorStatus: 'idle', cards },
  ],
  statusConfig: {
    idle: { indicatorStatus: 'idle', indicatorShape: 'dot', label: 'Idle' },
  },
  getResumeCommand: () => null,
  buildNativeClientSessionInput: () => null,
}))
vi.mock('@/components/chat/hooks/useSessionArchive', () => ({
  useSessionArchive: () => ({
    handleArchiveSession: mocks.archive,
    handleDeleteSession: mocks.remove,
  }),
}))
vi.mock('./useWorktreeMenuActions', () => ({
  useWorktreeMenuActions: () => ({
    handleArchiveOrClose: vi.fn(),
    preferences: { confirm_session_close: true },
  }),
}))
vi.mock('./WorktreeContextMenu', () => ({
  WorktreeContextMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('@/components/chat/CloseWorktreeDialog', () => ({
  CloseWorktreeDialog: ({
    open,
    mode,
    onConfirm,
  }: {
    open: boolean
    mode: string
    onConfirm: () => void
  }) =>
    open ? (
      <button type="button" onClick={onConfirm}>
        confirm {mode}
      </button>
    ) : null,
}))
vi.mock('@/components/chat/LabelModal', () => ({
  LabelModal: ({
    isOpen,
    sessionId,
  }: {
    isOpen: boolean
    sessionId: string
  }) => (isOpen ? <div>label modal {sessionId}</div> : null),
}))

const worktree: Worktree = {
  id: 'wt-1',
  project_id: 'project-1',
  name: 'feature',
  path: '/tmp/feature',
  branch: 'feature',
  created_at: 0,
  order: 0,
}

function renderExpanded() {
  useProjectsStore.setState({ expandedWorktreeIds: new Set(['wt-1']) })
  render(
    <WorktreeItem
      worktree={worktree}
      projectId="project-1"
      projectPath="/tmp/project"
      defaultBranch="main"
    />
  )
}

describe('WorktreeItem session context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessions = [
      { id: 's1', name: 'Busy chat', messages: [], message_count: 3 },
      { id: 's2', name: 'Empty chat', messages: [] },
    ]
  })

  it('opens the session menu when right-clicking a session row', () => {
    renderExpanded()

    fireEvent.contextMenu(screen.getByText('Busy chat'))

    for (const item of [
      'Rename',
      'Add Label',
      'Copy Session ID',
      'Archive Session',
      'Delete Session',
    ]) {
      expect(screen.getByRole('menuitem', { name: item })).toBeInTheDocument()
    }
  })

  it('confirms before deleting a non-empty session', async () => {
    const user = userEvent.setup()
    renderExpanded()

    fireEvent.contextMenu(screen.getByText('Busy chat'))
    await user.click(screen.getByRole('menuitem', { name: 'Delete Session' }))
    expect(mocks.remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'confirm session' }))

    expect(mocks.remove).toHaveBeenCalledWith('s1')
  })

  it('archives an empty session without confirmation', async () => {
    const user = userEvent.setup()
    renderExpanded()

    fireEvent.contextMenu(screen.getByText('Empty chat'))
    await user.click(screen.getByRole('menuitem', { name: 'Archive Session' }))

    expect(mocks.archive).toHaveBeenCalledWith('s2')
  })

  it('expands every project worktree from a status header', async () => {
    const user = userEvent.setup()
    renderExpanded()

    fireEvent.contextMenu(screen.getByText('Idle'))
    await user.click(screen.getByRole('menuitem', { name: 'Expand all' }))

    expect([...useProjectsStore.getState().expandedWorktreeIds].sort()).toEqual(
      ['wt-1', 'wt-2']
    )
  })

  it('collapses every project worktree when they are already expanded', async () => {
    const user = userEvent.setup()
    useProjectsStore.setState({
      expandedWorktreeIds: new Set(['wt-1', 'wt-2']),
    })
    render(
      <WorktreeItem
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
        defaultBranch="main"
      />
    )

    fireEvent.contextMenu(screen.getByText('Idle'))
    await user.click(screen.getByRole('menuitem', { name: 'Collapse all' }))

    expect(useProjectsStore.getState().expandedWorktreeIds.size).toBe(0)
  })

  it('opens the label modal for the clicked session', async () => {
    const user = userEvent.setup()
    renderExpanded()

    fireEvent.contextMenu(screen.getByText('Empty chat'))
    await user.click(screen.getByRole('menuitem', { name: 'Add Label' }))

    expect(screen.getByText('label modal s2')).toBeInTheDocument()
  })
})
