import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { AgentSummary } from '@/services/agents'
import { useUIStore } from '@/store/ui-store'
import { AgentsSidebar } from './AgentsSidebar'

const mocks = vi.hoisted(() => ({
  agents: [] as AgentSummary[],
  dialog: vi.fn(),
}))

vi.mock('./agents', async importOriginal => ({
  ...((await importOriginal()) as object),
  useSelectedAgent: () => ({
    agent: mocks.agents[0],
    agents: mocks.agents,
    isLoading: false,
    error: null,
  }),
}))

vi.mock('./NewAgentDialog', () => ({
  NewAgentDialog: (props: { open: boolean; defaultServerId?: string }) => {
    mocks.dialog(props)
    return props.open ? <div role="dialog">New agent dialog</div> : null
  },
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'jean',
    serverId: 'local',
    serverName: 'Local',
    name: 'Jean',
    description: 'The boss',
    icon: 'jean',
    rolePrompt: '',
    worktreeId: '__jean_agent__',
    paused: false,
    maxWakesPerHour: 12,
    builtin: true,
    status: 'idle',
    homeSessionId: null,
    pendingUpdates: 0,
    pendingApprovals: 0,
    activeDelegations: 0,
    nextScheduleAt: null,
    budgetReached: false,
    tasksWorktreeId: '__agent_tasks_jean__',
    runningTasks: 0,
    unreadNotifications: 0,
    activity: null,
    backend: null,
    model: null,
    effort: null,
    thinkingLevel: null,
    skills: [],
    ...overrides,
  }
}

describe('AgentsSidebar', () => {
  beforeEach(() => {
    mocks.dialog.mockClear()
    useUIStore.setState({ agentsServerFilter: 'all' })
  })

  it('lists Jean first and the user agents under "Your agents"', () => {
    mocks.agents = [
      agent({ id: 'reviewer', name: 'Reviewer', builtin: false }),
      agent({}),
    ]
    render(<AgentsSidebar />)
    const rows = screen
      .getAllByTestId(/^agent-row-/)
      .map(row => row.dataset.testid)
    expect(rows).toEqual(['agent-row-jean', 'agent-row-reviewer'])
    expect(screen.getByText('Your agents')).toBeInTheDocument()
  })

  it('opens the New agent dialog from the add control under Jean', async () => {
    mocks.agents = [agent({})]
    render(<AgentsSidebar />)
    expect(
      screen.getByText('Its own chat, memory, and schedules')
    ).toBeVisible()
    await userEvent.click(screen.getByTestId('agents-sidebar-add'))
    expect(screen.getByRole('dialog')).toHaveTextContent('New agent dialog')
  })

  it('opens the dialog from the section and header buttons too', async () => {
    mocks.agents = [agent({}), agent({ id: 'docs', builtin: false })]
    render(<AgentsSidebar />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('Its own chat, memory, and schedules')).toBeNull()
  })
})
