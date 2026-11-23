import { describe, expect, it } from 'vitest'
import {
  agentServerId,
  loadAgentsForServers,
  scopeAgentSummary,
  scopeProjectCoordinator,
  type AgentApproval,
  type AgentSummary,
} from '@/services/agents'
import {
  agentStatusLabel,
  findAgent,
  visibleAgentTabs,
  withRunningAgents,
} from './agents'
import { describeApproval } from './AgentActivity'
import { formatRelative } from '@/lib/relative-time'
import { formatInterval } from './AgentSchedules'
import { notificationPreview, splitNotifications } from './AgentInbox'
import { enabledAgentServers } from './agents-feature'
import { agentRunSummary } from './agent-config'

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'coord_p1',
    projectId: 'p1',
    serverId: 'local',
    serverName: 'Local',
    name: 'Orbit',
    description: '',
    icon: 'jean',
    rolePrompt: '',
    worktreeId: '__coord_p1__',
    maxWakesPerHour: 12,
    builtin: false,
    status: 'idle',
    homeSessionId: null,
    pendingUpdates: 0,
    pendingApprovals: 0,
    activeDelegations: 0,
    nextScheduleAt: null,
    budgetReached: false,
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

describe('agentStatusLabel', () => {
  it('shows work, waiting and budget', () => {
    expect(agentStatusLabel(agent({ status: 'working' }))).toBe('Working')
    expect(agentStatusLabel(agent({ unreadNotifications: 1 }))).toBe(
      '1 new notification'
    )
    expect(agentStatusLabel(agent({ status: 'waiting' }))).toBe(
      'Waiting for you'
    )
    expect(agentStatusLabel(agent({ budgetReached: true }))).toBe(
      'Hourly limit reached'
    )
    expect(
      agentStatusLabel(agent({ pendingApprovals: 2, activeDelegations: 3 }))
    ).toBeNull()
  })
})

describe('findAgent', () => {
  const agents = [agent({}), agent({ id: 'reviewer', builtin: false })]

  it('finds by id and falls back to the first agent', () => {
    expect(findAgent(agents, 'reviewer')?.id).toBe('reviewer')
    expect(findAgent(agents, 'deleted-agent')?.id).toBe('coord_p1')
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
  it('names the action and its worktree by name', () => {
    const approval: AgentApproval = {
      id: 1,
      agentId: 'jean',
      tool: 'delete_worktree',
      args: { worktreeId: 'wt-1' },
      status: 'pending',
      result: null,
      createdAt: 0,
    }
    // Names, never IDs
    expect(describeApproval(approval, 'feature-x')).toBe(
      'Delete worktree feature-x'
    )
    expect(describeApproval(approval)).toBe('Delete a worktree')
    expect(
      describeApproval({
        ...approval,
        tool: 'push_worktree',
        args: { worktreePath: '/home/me/jean/app/fix-login/' },
      })
    ).toBe('Push worktree fix-login')
    expect(
      describeApproval(
        { ...approval, tool: 'remove_project', args: { projectId: 'p-1' } },
        'my-app'
      )
    ).toBe('Remove project my-app')
    expect(
      describeApproval({
        ...approval,
        tool: 'remove_project',
        args: { projectId: 'p-1' },
      })
    ).toBe('Remove a project')
    expect(
      describeApproval({ ...approval, tool: 'custom_tool', args: {} })
    ).toBe('custom tool')
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
  it('scopes a remote project coordinator like its project key', () => {
    const raw = {
      agentId: 'coord_p1',
      worktreeId: '__coord_p1__',
      worktreePath: '/repos/orbit',
      chatSessionId: 's1',
      backend: null,
      model: null,
      effort: null,
      thinkingLevel: null,
    }
    expect(scopeProjectCoordinator('p1', raw)).toEqual(raw)
    expect(scopeProjectCoordinator('srv:p1', raw)).toEqual({
      ...raw,
      agentId: 'srv:coord_p1',
      worktreeId: 'srv:__coord_p1__',
      chatSessionId: 'srv:s1',
    })
  })

  it('scopes remote agent IDs so commands and chats route to that server', () => {
    const raw = agent({ id: 'reviewer', homeSessionId: 's1' })
    const local = scopeAgentSummary('local', 'Local', raw)
    expect(local.id).toBe('reviewer')
    expect(local.worktreeId).toBe('__coord_p1__')
    expect(local.projectId).toBe('p1')
    const remote = scopeAgentSummary('srv', 'Home server', raw)
    expect(remote.id).toBe('srv:reviewer')
    expect(remote.worktreeId).toBe('srv:__coord_p1__')
    expect(remote.projectId).toBe('srv:p1')
    expect(remote.homeSessionId).toBe('srv:s1')
    expect(remote.serverName).toBe('Home server')
    expect(remote.backend).toBeNull()
    expect(remote.skills).toEqual([])
    expect(agentServerId(remote.id)).toBe('srv')
    expect(agentServerId(local.id)).toBe('local')
  })

  it('defaults the run configuration of agents from an older server', () => {
    const {
      backend: _backend,
      model: _model,
      effort: _effort,
      thinkingLevel: _thinkingLevel,
      skills: _skills,
      ...old
    } = agent({ id: 'reviewer' })
    const remote = scopeAgentSummary('srv', 'Old server', old)
    expect(remote.backend).toBeNull()
    expect(remote.model).toBeNull()
    expect(remote.effort).toBeNull()
    expect(remote.thinkingLevel).toBeNull()
    expect(remote.skills).toEqual([])
    expect(agentRunSummary(remote)).toBeNull()
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
        // An older server still lists an agent that is not a coordinator
        const { projectId: _projectId, ...legacy } = agent({ id: 'jean' })
        return [agent({}), legacy as AgentSummary]
      }
    )
    expect(agents.map(a => a.id)).toEqual(['coord_p1', 'srv:coord_p1'])
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
  it('marks agents whose home chat is running as working', () => {
    const idle = agent({ id: 'a', homeSessionId: 's1' })
    const other = agent({ id: 'c', homeSessionId: 's3' })
    const result = withRunningAgents([idle, other], new Set(['s1']))
    expect(result?.map(a => a.status)).toEqual(['working', 'idle'])
    const list = [idle]
    expect(withRunningAgents(list, new Set())).toBe(list)
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

describe('visibleAgentTabs', () => {
  it('shows only Schedules by default', () => {
    expect(visibleAgentTabs(false, agent({}), 'schedules')).toEqual([
      'schedules',
    ])
  })

  it('adds Inbox while it has unread messages or is open', () => {
    expect(
      visibleAgentTabs(false, agent({ unreadNotifications: 2 }), 'schedules')
    ).toEqual(['inbox', 'schedules'])
    expect(visibleAgentTabs(false, agent({}), 'inbox')).toEqual([
      'inbox',
      'schedules',
    ])
  })

  it('hides advanced tabs even when one was open', () => {
    expect(visibleAgentTabs(false, agent({}), 'memory')).not.toContain('memory')
  })

  it('shows every tab in advanced mode', () => {
    expect(visibleAgentTabs(true, agent({}), 'schedules')).toEqual([
      'inbox',
      'schedules',
      'activity',
      'memory',
      'settings',
    ])
  })
})
