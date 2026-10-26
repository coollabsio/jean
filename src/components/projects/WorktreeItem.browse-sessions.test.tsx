import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { BROWSE_WORKTREE_SESSIONS_EVENT } from '@/components/dashboard/worktree-sessions-browser'
import { WorktreeItem } from './WorktreeItem'

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
  useSessions: () => ({
    data: {
      sessions: [
        { id: 's1', name: 'Busy chat', messages: [], message_count: 2 },
      ],
    },
  }),
  useRenameSession: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/services/projects', () => ({
  useRenameWorktree: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/components/chat/hooks/useCanvasStoreState', () => ({
  useCanvasStoreState: () => ({}),
}))
vi.mock('@/components/chat/session-card-utils', () => ({
  createSessionCardDataCache: () => () => ({}),
  groupCardsByStatus: () => [],
  statusConfig: {},
}))
vi.mock('@/components/chat/hooks/useSessionArchive', () => ({
  useSessionArchive: () => ({ handleDeleteSession: vi.fn() }),
}))
vi.mock('./useWorktreeMenuActions', () => ({
  useWorktreeMenuActions: () => ({
    handleArchiveOrClose: vi.fn(),
    preferences: {},
  }),
}))
vi.mock('./WorktreeContextMenu', () => ({
  WorktreeContextMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('@/components/chat/CloseWorktreeDialog', () => ({
  CloseWorktreeDialog: () => null,
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

describe('WorktreeItem sessions browser', () => {
  beforeEach(() => {
    useProjectsStore.setState({ expandedWorktreeIds: new Set() })
  })

  it('focuses the worktree sessions browser instead of opening a session tab', () => {
    vi.useFakeTimers()
    const browsed: unknown[] = []
    const opened: unknown[] = []
    const onBrowse = (event: Event) => {
      browsed.push((event as CustomEvent).detail)
    }
    const onOpen = (event: Event) => {
      opened.push((event as CustomEvent).detail)
    }
    window.addEventListener(BROWSE_WORKTREE_SESSIONS_EVENT, onBrowse)
    window.addEventListener('open-session-modal', onOpen)

    render(
      <WorktreeItem
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
        defaultBranch="main"
      />
    )
    fireEvent.click(screen.getByText('feature'))

    expect(browsed).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        worktreePath: '/tmp/feature',
      },
    ])
    vi.advanceTimersByTime(50)
    expect(browsed).toHaveLength(2)
    expect(opened).toEqual([])

    window.removeEventListener(BROWSE_WORKTREE_SESSIONS_EVENT, onBrowse)
    window.removeEventListener('open-session-modal', onOpen)
    vi.useRealTimers()
  })
})
