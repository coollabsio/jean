import { describe, expect, it } from 'vitest'
import {
  loadAgentsForServers,
  scopeAgentSummary,
  scopeProjectCoordinator,
  type AgentApproval,
  type AgentDelegation,
  type AgentSummary,
} from '@/services/agents'
import {
  coordinatorAgentIdForWorktree,
  coordinatorProjectId,
  coordinatorProjectIdForWorktree,
  openDelegations,
} from './agents'
import { describeApproval } from './AgentActivity'
import { formatRelative } from '@/lib/relative-time'
import { formatInterval } from './AgentSchedules'
import { enabledAgentServers } from './agents-feature'

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
    activity: null,
    backend: null,
    model: null,
    effort: null,
    thinkingLevel: null,
    skills: [],
    ...overrides,
  }
}

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
        { serverId: 'srv', coordinatorEnabled: true },
        { serverId: 'old', coordinatorEnabled: undefined },
      ])
    ).toEqual(['srv'])
    expect(
      enabledAgentServers(true, [
        { serverId: 'srv', coordinatorEnabled: false },
      ])
    ).toEqual(['local'])
    expect(enabledAgentServers(undefined, [])).toEqual([])
  })
})

describe('coordinator IDs', () => {
  it('maps a coordinator chat worktree to its agent, keeping the server', () => {
    expect(coordinatorAgentIdForWorktree('__coord_p1__')).toBe('coord_p1')
    expect(coordinatorAgentIdForWorktree('srv:__coord_p1__')).toBe(
      'srv:coord_p1'
    )
    expect(coordinatorAgentIdForWorktree('wt-1')).toBeNull()
    expect(coordinatorAgentIdForWorktree(null)).toBeNull()
  })

  it('maps a coordinator agent to its project', () => {
    expect(coordinatorProjectId('coord_p1')).toBe('p1')
    expect(coordinatorProjectId('srv:coord_p1')).toBe('srv:p1')
    expect(coordinatorProjectId('jean')).toBeNull()
  })

  it('maps a coordinator chat worktree to its project', () => {
    expect(coordinatorProjectIdForWorktree('__coord_p1__')).toBe('p1')
    expect(coordinatorProjectIdForWorktree('srv:__coord_p1__')).toBe('srv:p1')
    expect(coordinatorProjectIdForWorktree('wt-1')).toBeNull()
    expect(coordinatorProjectIdForWorktree(undefined)).toBeNull()
  })
})

describe('openDelegations', () => {
  const delegation = (id: number, status: string): AgentDelegation => ({
    id,
    agentId: 'coord_p1',
    sessionId: `s${id}`,
    worktreeId: `w${id}`,
    hop: 0,
    status,
    lastEvent: null,
    lastError: null,
    lastSummary: null,
    checkAfter: null,
    updatedAt: 0,
  })

  it('keeps active and waiting delegations only', () => {
    const open = openDelegations([
      delegation(1, 'active'),
      delegation(2, 'waiting'),
      delegation(3, 'done'),
      delegation(4, 'failed'),
      delegation(5, 'cancelled'),
    ])
    expect([...open.sessionIds]).toEqual(['s1', 's2'])
  })

  it('is empty without data', () => {
    expect(openDelegations(undefined).sessionIds.size).toBe(0)
  })
})
