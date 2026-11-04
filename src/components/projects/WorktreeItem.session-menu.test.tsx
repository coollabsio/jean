import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useSubSessionStore } from '@/store/sub-session-store'
import { WorktreeItem } from './WorktreeItem'

const mocks = vi.hoisted(() => ({
  sessions: [] as {
    id: string
    name: string
    messages: []
    message_count?: number
    delegated_by?: { origin_session_id: string; origin_worktree_id: string }
  }[],
  remove: vi.fn(),
  removeMany: vi.fn(),
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
  useCloseSession: () => ({ mutate: mocks.remove }),
  useCloseSessions: () => mocks.removeMany,
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
  isActionableWaitingStatus: () => false,
  getResumeCommand: () => null,
  buildNativeClientSessionInput: () => null,
}))
vi.mock('./useWorktreeMenuActions', () => ({
  useWorktreeMenuActions: () => ({
    handleClose: vi.fn(),
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
    finishedSubSessionCount,
  }: {
    open: boolean
    mode: string
    onConfirm: (options: { closeSubSessions: boolean }) => void
    finishedSubSessionCount?: number
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => onConfirm({ closeSubSessions: true })}
      >
        confirm {mode}
        {finishedSubSessionCount ? ` with ${finishedSubSessionCount}` : ''}
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

function closeArgs(sessionId: string) {
  return { worktreeId: 'wt-1', worktreePath: '/tmp/feature', sessionId }
}

function middleClick(element: HTMLElement, init: MouseEventInit = {}) {
  fireEvent(
    element,
    new MouseEvent('auxclick', { bubbles: true, button: 1, ...init })
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

    expect(mocks.remove).toHaveBeenCalledWith(closeArgs('s1'))
  })

  it('confirms a middle-click close of a non-empty session, even with Shift or Alt held', () => {
    renderExpanded()

    middleClick(screen.getByText('Busy chat'), { shiftKey: true, altKey: true })

    expect(mocks.remove).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'confirm session' })
    ).toBeInTheDocument()
  })

  it('deletes an empty session on middle-click without confirmation', () => {
    renderExpanded()

    middleClick(screen.getByText('Empty chat'))

    expect(mocks.remove).toHaveBeenCalledWith(closeArgs('s2'))
    expect(
      screen.queryByRole('button', { name: 'confirm session' })
    ).not.toBeInTheDocument()
  })

  it('confirms a middle-click close of the worktree, even with Shift held', () => {
    renderExpanded()

    middleClick(screen.getByText('feature'), { shiftKey: true })

    expect(
      screen.getByRole('button', { name: 'confirm worktree' })
    ).toBeInTheDocument()
  })

  it('deletes an empty session from the menu without confirmation', async () => {
    const user = userEvent.setup()
    renderExpanded()

    fireEvent.contextMenu(screen.getByText('Empty chat'))
    await user.click(screen.getByRole('menuitem', { name: 'Delete Session' }))

    expect(mocks.remove).toHaveBeenCalledWith(closeArgs('s2'))
    expect(
      screen.queryByRole('button', { name: 'confirm session' })
    ).not.toBeInTheDocument()
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

  describe('sub-sessions', () => {
    const delegatedBy = {
      origin_session_id: 'lead',
      origin_worktree_id: 'wt-1',
    }
    beforeEach(() => {
      useSubSessionStore.setState({ collapsedLeadSessionIds: new Set() })
      mocks.sessions = [
        {
          id: 'child',
          name: 'Child chat',
          messages: [],
          message_count: 1,
          delegated_by: delegatedBy,
        },
        { id: 'plain', name: 'Plain chat', messages: [] },
        { id: 'lead', name: 'Lead chat', messages: [], message_count: 2 },
      ]
    })

    const rowNames = () =>
      screen
        .getAllByRole('button', { name: /chat$/ })
        .map(button => button.textContent)

    it('lists a sub-session right under its lead', () => {
      renderExpanded()

      expect(rowNames()).toEqual(['Plain chat', 'Lead chat', 'Child chat'])
    })

    it('hides sub-sessions when the lead collapses', async () => {
      const user = userEvent.setup()
      renderExpanded()

      await user.click(
        screen.getByRole('button', { name: 'Hide sub-sessions' })
      )

      expect(rowNames()).toEqual(['Plain chat', 'Lead chat'])
      expect(
        screen.getByRole('button', { name: 'Show sub-sessions' })
      ).toBeInTheDocument()
    })

    it('shows no collapse control on a session without sub-sessions', () => {
      mocks.sessions = [{ id: 'plain', name: 'Plain chat', messages: [] }]
      renderExpanded()

      expect(
        screen.queryByRole('button', { name: /sub-sessions/ })
      ).not.toBeInTheDocument()
    })

    it('offers to close finished sub-sessions with their lead', async () => {
      const user = userEvent.setup()
      renderExpanded()

      fireEvent.contextMenu(screen.getByText('Lead chat'))
      await user.click(screen.getByRole('menuitem', { name: 'Delete Session' }))
      await user.click(
        screen.getByRole('button', { name: 'confirm session with 1' })
      )

      expect(mocks.removeMany).toHaveBeenCalledWith(
        'wt-1',
        '/tmp/feature',
        'lead',
        ['child']
      )
      expect(mocks.remove).not.toHaveBeenCalled()
    })

    it('closes only the sub-session itself, never its lead', async () => {
      const user = userEvent.setup()
      renderExpanded()

      fireEvent.contextMenu(screen.getByText('Child chat'))
      await user.click(screen.getByRole('menuitem', { name: 'Delete Session' }))
      await user.click(screen.getByRole('button', { name: 'confirm session' }))

      expect(mocks.remove).toHaveBeenCalledWith(closeArgs('child'))
      expect(mocks.removeMany).not.toHaveBeenCalled()
    })
  })
})
