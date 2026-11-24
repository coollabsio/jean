import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Project, RecentWorktreeItem, Worktree } from '@/types/projects'
import type { Session } from '@/types/chat'
import { CoordinatorView } from './CoordinatorView'
import { delegatedSessionRows } from './CoordinatorWorktrees'

const mocks = vi.hoisted(() => ({
  isMobile: false,
  items: [] as RecentWorktreeItem[],
  delegatedSessionIds: [] as string[],
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/components/chat/ChatWindow', () => ({
  ChatWindow: () => <div>coordinator chat</div>,
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
  useAgentsList: () => ({ data: [{ id: 'jean', projectId: 'p1' }] }),
  useAgentDetails: (agentId: string | null) => ({
    data: agentId
      ? {
          delegations: mocks.delegatedSessionIds.map((sessionId, id) => ({
            id,
            sessionId,
          })),
        }
      : undefined,
    error: null,
  }),
}))
vi.mock('./AgentMemoryView', () => ({
  AgentMemoryView: () => <div>memory view</div>,
}))
vi.mock('./AgentSchedules', () => ({ AgentSchedules: () => null }))
vi.mock('./AgentSettings', () => ({ AgentSettings: () => null }))
vi.mock('@/services/projects', async importOriginal => ({
  ...((await importOriginal()) as object),
  fetchRecentWorktrees: async () => ({
    items: mocks.items,
    total: mocks.items.length,
  }),
}))

const NOW = Math.floor(Date.now() / 1000)

function row(
  worktreeId: string,
  sessionId: string,
  session: Partial<Session> = {},
  worktree: Partial<Worktree> = {}
): RecentWorktreeItem {
  return {
    projectId: 'p1',
    projectName: 'Project',
    worktree: {
      id: worktreeId,
      name: `wt-${worktreeId}`,
      path: `/${worktreeId}`,
      ...worktree,
    },
    session: { id: sessionId, name: `session ${sessionId}`, ...session },
    lastActivityAt: NOW,
    added: 0,
    removed: 0,
  } as RecentWorktreeItem
}

const project = { id: 'p1', name: 'My Project' } as Project

function renderView() {
  return render(
    <CoordinatorView
      project={project}
      viewSwitch={<span>switch</span>}
      sessionModalHost={null}
    />
  )
}

beforeEach(() => {
  mocks.isMobile = false
  mocks.items = []
  mocks.delegatedSessionIds = []
  useUIStore.setState({ coordinatorSidebarOpen: false })
  useChatStore.setState({
    sendingSessionIds: {},
    waitingForInputSessionIds: {},
  })
})

describe('delegatedSessionRows', () => {
  const statusOf = (item: RecentWorktreeItem) =>
    item.session.waiting_for_input
      ? ({ label: 'Waiting', tone: 'waiting' } as const)
      : item.session.last_run_status === 'running'
        ? ({ label: 'Working', tone: 'working' } as const)
        : ({ label: 'Completed', tone: 'completed' } as const)

  it('keeps delegated non-base sessions, running first, one row each', () => {
    const rows = delegatedSessionRows(
      [
        row('a', 'a-done'),
        row('b', 'b-wait', { waiting_for_input: true }),
        row('a', 'a-run', { last_run_status: 'running' }),
        row('c', 'c-mine', { last_run_status: 'running' }),
        row(
          'base',
          'base-run',
          { last_run_status: 'running' },
          {
            session_type: 'base',
          }
        ),
      ],
      new Set(['a-done', 'b-wait', 'a-run', 'base-run']),
      statusOf
    )
    expect(rows.map(r => [r.item.session.id, r.tone])).toEqual([
      ['a-run', 'running'],
      ['b-wait', 'waiting'],
      ['a-done', 'done'],
    ])
  })
})

describe('CoordinatorView', () => {
  it('shows only the chat in the main area and no header tabs', () => {
    renderView()
    expect(screen.getByText('My Project')).toBeVisible()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(
      screen.queryByRole('complementary', { name: 'Coordinator details' })
    ).toBeNull()
  })

  it('lists only delegated sessions in the sidebar and opens one', async () => {
    mocks.delegatedSessionIds = ['a-run', 'b-done', 'base-run']
    mocks.items = [
      row('a', 'a-run', { last_run_status: 'running' }),
      row('b', 'b-done', { last_run_status: 'completed' }),
      row('c', 'c-mine', { last_run_status: 'running' }),
      row(
        'base',
        'base-run',
        { last_run_status: 'running' },
        {
          session_type: 'base',
        }
      ),
    ]
    renderView()
    expect(await screen.findByText('coordinator chat')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Show details' }))

    const aside = screen.getByRole('complementary', {
      name: 'Coordinator details',
    })
    expect(
      within(aside).getByRole('tab', { name: 'Sessions' })
    ).toHaveAttribute('aria-selected', 'true')
    const items = await within(aside).findAllByRole('listitem')
    expect(items.map(item => item.textContent)).toEqual([
      'wt-asession a-runnow',
      'wt-bsession b-donenow',
    ])

    const onOpen = vi.fn()
    window.addEventListener('open-session-modal', onOpen)
    await userEvent.click(within(aside).getByText('wt-a'))
    window.removeEventListener('open-session-modal', onOpen)
    expect(onOpen.mock.calls[0]?.[0].detail).toEqual({
      sessionId: 'a-run',
      worktreeId: 'a',
      worktreePath: '/a',
    })

    await userEvent.click(within(aside).getByRole('tab', { name: 'Memory' }))
    expect(within(aside).getByText('memory view')).toBeVisible()
    expect(screen.getByText('coordinator chat')).toBeVisible()
    expect(useUIStore.getState().coordinatorSidebarOpen).toBe(true)
  })

  it('says so in the sidebar when the coordinator started no work', async () => {
    mocks.items = [row('c', 'c-mine', { last_run_status: 'running' })]
    renderView()
    await userEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(
      await screen.findByText('The coordinator has not started any work yet.')
    ).toBeVisible()
    expect(screen.getByText('coordinator chat')).toBeVisible()
  })

  it('on mobile opens the details as a sheet that closes after opening a session', async () => {
    mocks.isMobile = true
    mocks.delegatedSessionIds = ['a-run']
    mocks.items = [row('a', 'a-run', { last_run_status: 'running' })]
    renderView()
    await userEvent.click(screen.getByRole('button', { name: 'Show details' }))

    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('tab', { name: 'Memory' })).toBeVisible()
    expect(useUIStore.getState().coordinatorSidebarOpen).toBe(false)
    await userEvent.click(await within(sheet).findByText('wt-a'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
