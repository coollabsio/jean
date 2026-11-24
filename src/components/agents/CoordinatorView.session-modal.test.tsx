import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { render, screen } from '@/test/test-utils'
import { ProjectCanvasView } from '@/components/dashboard/ProjectCanvasView'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Project, Worktree } from '@/types/projects'
import { CoordinatorView } from './CoordinatorView'

const WORKTREE = {
  id: 'wt1',
  project_id: 'p1',
  name: 'feature',
  path: '/wt1',
  status: 'ready',
} as Worktree

vi.mock('@/components/chat/ChatWindow', () => ({
  ChatWindow: () => <div>coordinator chat</div>,
}))
vi.mock('@/components/chat/SessionChatModal', () => ({
  SessionChatModal: ({
    isOpen,
    worktreeId,
  }: {
    isOpen: boolean
    worktreeId: string
  }) => (isOpen ? <div>session modal {worktreeId}</div> : null),
}))
vi.mock('@/services/agents', async importOriginal => ({
  ...((await importOriginal()) as object),
  useProjectCoordinator: () => ({
    data: {
      agentId: 'coord_p1',
      worktreeId: 'coord-wt',
      worktreePath: '/c',
      chatSessionId: 's0',
    },
    error: null,
  }),
  useAgentsList: () => ({ data: [] }),
}))
vi.mock('@/services/projects', async importOriginal => ({
  ...((await importOriginal()) as object),
  useProjectBootstrap: () => ({ data: [WORKTREE], isLoading: false }),
}))

const project = { id: 'p1', name: 'My Project', path: '/p1' } as Project

function renderCoordinator() {
  return render(
    <CoordinatorView
      project={project}
      viewSwitch={<span>switch</span>}
      sessionModalHost={
        <ProjectCanvasView projectId="p1" project={project} embedded />
      }
    />
  )
}

beforeEach(() => {
  // jsdom has no scrolling; the canvas scrolls the selected row into view
  Element.prototype.scrollBy = vi.fn()
  useUIStore.setState({
    coordinatorSidebarOpen: false,
    autoOpenSessionWorktreeIds: new Set(),
    pendingAutoOpenSessionIds: {},
  })
})

describe('CoordinatorView session modal', () => {
  it('shows a session opened from the header unread list', async () => {
    renderCoordinator()
    expect(await screen.findByText('coordinator chat')).toBeVisible()
    expect(screen.queryByText('session modal wt1')).toBeNull()

    // What UnreadBell does when the user picks a finished session
    act(() => {
      useChatStore.getState().setActiveSession('wt1', 's1')
      useUIStore.getState().markWorktreeForAutoOpenSession('wt1', 's1')
    })

    expect(await screen.findByText('session modal wt1')).toBeVisible()
  })

  it('shows a session opened from the Sessions tab', async () => {
    renderCoordinator()

    // What CoordinatorWorktrees does when the user picks a session row
    act(() => {
      window.dispatchEvent(
        new CustomEvent('open-session-modal', {
          detail: { sessionId: 's1', worktreeId: 'wt1', worktreePath: '/wt1' },
        })
      )
    })

    expect(await screen.findByText('session modal wt1')).toBeVisible()
  })
})
