import { describe, expect, it } from 'vitest'
import {
  agentServerId,
  loadAgentsForServers,
  scopeAgentSummary,
  type AgentApproval,
  type AgentSummary,
} from '@/services/agents'
import {
  agentRowDot,
  agentServers,
  filterAgentsByServer,
} from './AgentsSidebar'
import { agentStatusLabel, agentSubtitle, findAgent } from './agents'
import { describeApproval, formatRelative } from './AgentActivity'
import { taskStatusLabel } from './AgentTasks'
import { formatInterval } from './AgentSchedules'
import { notificationPreview, splitNotifications } from './AgentInbox'
import { enabledAgentServers } from './agents-feature'

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'jean',
    serverId: 'local',
    serverName: 'Local',
    name: 'Jean',
    description: '',
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
    ...overrides,
  }
}

describe('agentStatusLabel', () => {
  it('puts paused and approvals before other states', () => {
    expect(
      agentStatusLabel(agent({ status: 'paused', pendingApprovals: 2 }))
    ).toBe('Paused')
    expect(
      agentStatusLabel(agent({ status: 'working', pendingApprovals: 2 }))
    ).toBe('Needs approval (2)')
  })

  it('shows work, waiting, budget and followed sessions', () => {
    expect(agentStatusLabel(agent({ status: 'working' }))).toBe('Working')
    expect(
      agentStatusLabel(agent({ status: 'working', runningTasks: 2 }))
    ).toBe('Working (2 tasks)')
    expect(agentStatusLabel(agent({ unreadNotifications: 1 }))).toBe(
      '1 new notification'
    )
    expect(agentStatusLabel(agent({ status: 'waiting' }))).toBe(
      'Waiting for you'
    )
    expect(agentStatusLabel(agent({ budgetReached: true }))).toBe(
      'Hourly limit reached'
    )
    expect(agentStatusLabel(agent({ activeDelegations: 1 }))).toBe(
      'Following 1 session'
    )
    expect(agentStatusLabel(agent({ activeDelegations: 3 }))).toBe(
      'Following 3 sessions'
    )
    expect(agentStatusLabel(agent({}))).toBe('Idle')
  })
})

describe('findAgent', () => {
  const agents = [agent({}), agent({ id: 'reviewer', builtin: false })]

  it('finds by id and falls back to the first agent', () => {
    expect(findAgent(agents, 'reviewer')?.id).toBe('reviewer')
    expect(findAgent(agents, 'deleted-agent')?.id).toBe('jean')
    expect(findAgent(undefined, 'jean')).toBeUndefined()
  })
})

describe('formatRelative', () => {
  const now = 1_000_000_000_000

  it('formats past and future times', () => {
    expect(formatRelative(now / 1000, now)).toBe('now')
    expect(formatRelative(now / 1000 - 120, now)).toBe('2m ago')
    expect(formatRelative(now / 1000 + 7200, now)).toBe('in 2h')
    expect(formatRelative(now / 1000 - 3 * 86_400, now)).toBe('3d ago')
  })
})

describe('describeApproval', () => {
  it('names the action and its worktree', () => {
    const approval: AgentApproval = {
      id: 1,
      agentId: 'jean',
      tool: 'permanently_delete_worktree',
      args: { worktreeId: 'wt-1' },
      status: 'pending',
      result: null,
      createdAt: 0,
    }
    expect(describeApproval(approval)).toBe('Permanently delete worktree wt-1')
    expect(describeApproval({ ...approval, tool: 'custom', args: {} })).toBe(
      'custom'
    )
  })
})

describe('taskStatusLabel', () => {
  it('explains waiting tasks', () => {
    expect(taskStatusLabel('waiting')).toBe('waiting for sessions')
    expect(taskStatusLabel('done')).toBe('done')
  })
})

describe('formatInterval', () => {
  it('uses the largest whole unit', () => {
    expect(formatInterval(30 * 60)).toBe('every 30m')
    expect(formatInterval(2 * 3600)).toBe('every 2h')
    expect(formatInterval(86_400)).toBe('every 1d')
    expect(formatInterval(90 * 60)).toBe('every 90m')
  })
})

describe('splitNotifications', () => {
  it('keeps unread apart from read and keeps order', () => {
    const n = (id: number, readAt: number | null) => ({
      id,
      agentId: 'jean',
      sessionId: null,
      level: 'info',
      message: `m${id}`,
      createdAt: id,
      readAt,
    })
    const { unread, read } = splitNotifications([
      n(3, null),
      n(2, 5),
      n(1, null),
    ])
    expect(unread.map(x => x.id)).toEqual([3, 1])
    expect(read.map(x => x.id)).toEqual([2])
  })
})

describe('multi-server agents', () => {
  it('scopes remote agent IDs so commands and chats route to that server', () => {
    const raw = agent({ id: 'reviewer', homeSessionId: 's1' })
    const local = scopeAgentSummary('local', 'Local', raw)
    expect(local.id).toBe('reviewer')
    expect(local.worktreeId).toBe('__jean_agent__')
    const remote = scopeAgentSummary('srv', 'Home server', raw)
    expect(remote.id).toBe('srv:reviewer')
    expect(remote.worktreeId).toBe('srv:__jean_agent__')
    expect(remote.tasksWorktreeId).toBe('srv:__agent_tasks_jean__')
    expect(remote.homeSessionId).toBe('srv:s1')
    expect(remote.serverName).toBe('Home server')
    expect(agentServerId(remote.id)).toBe('srv')
    expect(agentServerId(local.id)).toBe('local')
  })

  it('loads agents from online servers and skips failing ones', async () => {
    const agents = await loadAgentsForServers(
      [
        { serverId: 'local', name: 'Local', online: true },
        { serverId: 'srv', name: 'Remote', online: true },
        { serverId: 'old', name: 'Old Jean', online: true },
        { serverId: 'off', name: 'Offline', online: false },
      ],
      async serverId => {
        if (serverId === 'old') throw new Error('Unknown command: list_agents')
        if (serverId === 'off') throw new Error('must not be called')
        return [agent({})]
      }
    )
    expect(agents.map(a => a.id)).toEqual(['jean', 'srv:jean'])
  })

  it('lists servers once and filters by server', () => {
    const list = [
      { ...agent({}), serverId: 'local', serverName: 'Local' },
      { ...agent({ id: 'srv:jean' }), serverId: 'srv', serverName: 'Remote' },
    ]
    expect(agentServers(list)).toEqual([
      ['local', 'Local'],
      ['srv', 'Remote'],
    ])
    expect(filterAgentsByServer(list, 'all')).toHaveLength(2)
    expect(filterAgentsByServer(list, 'srv').map(a => a.id)).toEqual([
      'srv:jean',
    ])
  })
})

describe('enabledAgentServers', () => {
  it('shows agents when any server has them on', () => {
    // Off on this computer, on for a remote server
    expect(
      enabledAgentServers(false, [
        { serverId: 'srv', agentsEnabled: true },
        { serverId: 'old', agentsEnabled: undefined },
      ])
    ).toEqual(['srv'])
    expect(
      enabledAgentServers(true, [{ serverId: 'srv', agentsEnabled: false }])
    ).toEqual(['local'])
    expect(enabledAgentServers(undefined, [])).toEqual([])
  })
})

describe('agent rows', () => {
  it('shows what needs the user first, then the latest activity', () => {
    expect(agentSubtitle(agent({ status: 'paused', activity: 'x' }))).toBe(
      'Stopped'
    )
    expect(agentSubtitle(agent({ pendingApprovals: 1 }))).toBe(
      'Needs your approval'
    )
    expect(agentSubtitle(agent({ activity: 'Pushed the fix' }))).toBe(
      'Pushed the fix'
    )
    expect(agentSubtitle(agent({ description: 'Coordinates' }))).toBe(
      'Coordinates'
    )
    expect(agentSubtitle(agent({}))).toBe('No activity yet')
  })

  it('marks unread messages and things that need the user', () => {
    expect(agentRowDot(agent({ unreadNotifications: 2 }))).toBe('unread')
    expect(
      agentRowDot(agent({ unreadNotifications: 2, pendingApprovals: 1 }))
    ).toBe('attention')
    expect(agentRowDot(agent({ status: 'paused', pendingApprovals: 1 }))).toBe(
      null
    )
    expect(agentRowDot(agent({}))).toBe(null)
  })
})

describe('notificationPreview', () => {
  it('uses the first non-empty line', () => {
    expect(notificationPreview('\n  Disk check: ok  \n\n| a | b |')).toBe(
      'Disk check: ok'
    )
    expect(notificationPreview('   ')).toBe('')
  })
})
