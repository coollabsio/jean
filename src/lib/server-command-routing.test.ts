import { describe, expect, it } from 'vitest'
import {
  clearServerResourcePaths,
  decorateServerEvent,
  decorateServerResult,
  resolveServerCommand,
  registerServerResourcePath,
} from './server-command-routing'

describe('server command routing', () => {
  it('routes path-only GitHub and Git commands to the owning server', () => {
    clearServerResourcePaths()
    registerServerResourcePath('remote', '/srv/jean')

    expect(
      resolveServerCommand({ projectPath: '/srv/jean', state: 'open' })
    ).toEqual({
      serverId: 'remote',
      args: { projectPath: '/srv/jean', state: 'open' },
    })
  })

  it('rejects an ambiguous path instead of using the wrong server', () => {
    clearServerResourcePaths()
    registerServerResourcePath('one', '/srv/jean')
    registerServerResourcePath('two', '/srv/jean')

    expect(() => resolveServerCommand({ repoPath: '/srv/jean' })).toThrow(
      'ambiguous'
    )
  })

  it('adds server ownership to resource ids in events', () => {
    expect(
      decorateServerEvent('remote', {
        worktree_id: 'wt-1',
        sessionId: 'session-1',
        output: 'unchanged',
      })
    ).toEqual({
      worktree_id: 'remote:wt-1',
      sessionId: 'remote:session-1',
      output: 'unchanged',
    })
  })

  it('extracts one server and restores backend resource ids', () => {
    expect(
      resolveServerCommand({
        projectId: 'remote%3Aone:project%2F1',
        worktreeId: 'remote%3Aone:worktree%2F1',
        name: 'keep:literal',
      })
    ).toEqual({
      serverId: 'remote:one',
      args: {
        projectId: 'project/1',
        worktreeId: 'worktree/1',
        name: 'keep:literal',
      },
    })
  })

  it('rejects mixed server resource arguments', () => {
    expect(() =>
      resolveServerCommand({
        projectId: 'one:p1',
        worktreeId: 'two:w1',
      })
    ).toThrow('several Jean servers')
  })

  it('decorates project and worktree response identities', () => {
    expect(
      decorateServerResult('r1', 'bootstrap_project', {
        worktrees: [{ id: 'w1', project_id: 'p1', name: 'Worktree' }],
        sessionsByWorktree: { w1: { sessions: [{ id: 's1' }] } },
      })
    ).toEqual({
      worktrees: [
        {
          id: 'r1:w1',
          project_id: 'r1:p1',
          name: 'Worktree',
          serverId: 'r1',
          resourceId: 'w1',
        },
      ],
      sessionsByWorktree: {
        'r1:w1': {
          sessions: [{ id: 'r1:s1', serverId: 'r1', resourceId: 's1' }],
        },
      },
    })
  })

  it('decorates session mutation responses and their owner references', () => {
    expect(
      decorateServerResult('r1', 'create_session', {
        id: 's1',
        worktree_id: 'w1',
        parent_session_id: 's0',
      })
    ).toEqual({
      id: 'r1:s1',
      worktree_id: 'r1:w1',
      parent_session_id: 'r1:s0',
      serverId: 'r1',
      resourceId: 's1',
    })
  })
})
