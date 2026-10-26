import { describe, expect, it } from 'vitest'
import {
  clearServerResourcePaths,
  decorateServerEvent,
  decorateServerResult,
  resolveServerCommand,
  registerServerResourcePath,
  stripServerScope,
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

  it('leaves a raw id unscoped when the command has no path', () => {
    clearServerResourcePaths()
    registerServerResourcePath('remote', '/srv/project')

    expect(resolveServerCommand({ sessionId: 'session-1' })).toBeNull()
    expect(resolveServerCommand({ worktreeId: 'local-worktree' })).toBeNull()
  })

  it('resolves a shared path to the local server from a raw worktree id', () => {
    clearServerResourcePaths()
    registerServerResourcePath('local', '/srv/project')
    registerServerResourcePath('remote', '/srv/project')

    const expected = {
      serverId: 'local',
      args: {
        worktreeId: 'local-worktree',
        worktreePath: '/srv/project',
        name: 'New session',
      },
    }
    // create_session sends the id and the path together. Either property order
    // has to select the local worktree instead of failing as ambiguous.
    expect(
      resolveServerCommand({
        worktreeId: 'local-worktree',
        worktreePath: '/srv/project',
        name: 'New session',
      })
    ).toEqual(expected)
    expect(
      resolveServerCommand({
        worktreePath: '/srv/project',
        name: 'New session',
        worktreeId: 'local-worktree',
      })
    ).toEqual(expected)
  })

  it('does not send a raw local id to the only registered remote path owner', () => {
    clearServerResourcePaths()
    registerServerResourcePath('remote', '/srv/project')

    expect(() =>
      resolveServerCommand({
        worktreePath: '/srv/project',
        worktreeId: 'local-worktree',
      })
    ).toThrow('another Jean server')
  })

  it('lets a scoped id select its server when the path is shared', () => {
    clearServerResourcePaths()
    registerServerResourcePath('server-a', '/srv/project')
    registerServerResourcePath('server-b', '/srv/project')

    const expected = {
      serverId: 'server-b',
      args: { worktreeId: 'worktree-1', worktreePath: '/srv/project' },
    }
    expect(
      resolveServerCommand({
        worktreePath: '/srv/project',
        worktreeId: 'server-b:worktree-1',
      })
    ).toEqual(expected)
    expect(
      resolveServerCommand({
        worktreeId: 'server-b:worktree-1',
        worktreePath: '/srv/project',
      })
    ).toEqual(expected)
    expect(
      resolveServerCommand({
        payload: { worktreePath: '/srv/project' },
        worktreeId: 'server-b:worktree-1',
      })
    ).toEqual({
      serverId: 'server-b',
      args: {
        payload: { worktreePath: '/srv/project' },
        worktreeId: 'worktree-1',
      },
    })
  })

  it('keeps an explicit server when its ids were already stripped', () => {
    clearServerResourcePaths()
    registerServerResourcePath('local', '/srv/project')
    registerServerResourcePath('server-a', '/srv/project')
    registerServerResourcePath('server-b', '/srv/project')

    expect(
      resolveServerCommand(
        {
          worktreePath: '/srv/project',
          worktreeId: 'worktree-1',
          sessionId: 'server-b:session-1',
        },
        { explicitServerId: 'server-b' }
      )
    ).toEqual({
      serverId: 'server-b',
      args: {
        worktreePath: '/srv/project',
        worktreeId: 'worktree-1',
        sessionId: 'session-1',
      },
    })
    expect(
      stripServerScope('server-b', {
        worktreePath: '/srv/project',
        worktreeId: 'worktree-1',
        sessionId: 'server-b:session-1',
      })
    ).toEqual({
      worktreePath: '/srv/project',
      worktreeId: 'worktree-1',
      sessionId: 'session-1',
    })
  })

  it('rejects ids that name two servers even when a path matches one of them', () => {
    clearServerResourcePaths()
    registerServerResourcePath('remote', '/srv/project')

    expect(() =>
      resolveServerCommand({
        worktreePath: '/srv/project',
        worktreeId: 'local-worktree',
        sessionId: 'remote:session-1',
      })
    ).toThrow('several Jean servers')
  })

  it('lets one unique path disambiguate another shared path', () => {
    clearServerResourcePaths()
    registerServerResourcePath('server-a', '/srv/project')
    registerServerResourcePath('server-b', '/srv/project')
    registerServerResourcePath('server-b', '/srv/project/feature')

    expect(
      resolveServerCommand({
        repoPath: '/srv/project',
        worktreePath: '/srv/project/feature',
      })
    ).toEqual({
      serverId: 'server-b',
      args: {
        repoPath: '/srv/project',
        worktreePath: '/srv/project/feature',
      },
    })
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

  it('decorates worktree lifecycle events with their remote owner', () => {
    expect(
      decorateServerEvent(
        'remote',
        {
          worktree: {
            id: 'wt-1',
            project_id: 'project-1',
            path: '/srv/project/wt-1',
          },
          autoOpenInJean: false,
        },
        'worktree:created'
      )
    ).toEqual({
      worktree: {
        id: 'remote:wt-1',
        project_id: 'remote:project-1',
        path: '/srv/project/wt-1',
        serverId: 'remote',
        resourceId: 'wt-1',
      },
      autoOpenInJean: false,
    })

    expect(
      decorateServerEvent(
        'remote',
        { id: 'wt-1', project_id: 'project-1' },
        'worktree:setup_complete'
      )
    ).toEqual({ id: 'remote:wt-1', project_id: 'remote:project-1' })
  })

  it('routes terminal commands and gives remote terminal events the same id', () => {
    expect(
      resolveServerCommand({ terminalId: 'remote%3Adev:terminal%2F1' })
    ).toEqual({
      serverId: 'remote:dev',
      args: { terminalId: 'terminal/1' },
    })
    expect(
      decorateServerEvent('remote:dev', { terminal_id: 'terminal/1' })
    ).toEqual({ terminal_id: 'remote%3Adev:terminal%2F1' })
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

  it('routes and strips every item id in remote reorder commands', () => {
    expect(
      resolveServerCommand({
        itemIds: ['remote:one', 'remote:two'],
        parentId: 'remote:folder',
      })
    ).toEqual({
      serverId: 'remote',
      args: {
        itemIds: ['one', 'two'],
        parentId: 'folder',
      },
    })
  })

  it('routes remote folder commands and strips the folder id', () => {
    expect(
      resolveServerCommand({ folderId: 'remote:folder', name: 'Renamed' })
    ).toEqual({
      serverId: 'remote',
      args: { folderId: 'folder', name: 'Renamed' },
    })
  })

  it('decorates a renamed remote folder', () => {
    expect(
      decorateServerResult('remote', 'rename_folder', { id: 'folder' })
    ).toMatchObject({ id: 'remote:folder', serverId: 'remote' })
  })

  it('scopes the project returned by ensure_project_present', () => {
    expect(
      decorateServerResult('remote', 'ensure_project_present', {
        status: 'cloned',
        project: { id: 'jean', path: '/srv/jean' },
      })
    ).toMatchObject({
      status: 'cloned',
      project: {
        id: 'remote:jean',
        resourceId: 'jean',
        serverId: 'remote',
        path: '/srv/jean',
      },
    })
  })

  it('scopes remote unread session lists like full session lists', () => {
    for (const command of ['list_all_sessions', 'list_unread_sessions']) {
      expect(
        decorateServerResult('r1', command, {
          entries: [
            {
              project_id: 'p1',
              worktree_id: 'w1',
              sessions: [{ id: 's1', worktree_id: 'w1' }],
            },
          ],
        })
      ).toMatchObject({
        entries: [
          {
            project_id: 'r1:p1',
            worktree_id: 'r1:w1',
            sessions: [{ id: 'r1:s1', worktree_id: 'r1:w1' }],
          },
        ],
      })
    }
  })

  it('decorates a moved remote project', () => {
    expect(
      decorateServerResult('remote', 'move_item', {
        id: 'project',
        parent_id: 'folder',
      })
    ).toMatchObject({
      id: 'remote:project',
      parent_id: 'remote:folder',
      serverId: 'remote',
      resourceId: 'project',
    })
  })

  it('does not route resource ids stored inside UI state', () => {
    expect(
      resolveServerCommand({
        uiState: {
          active_project_id: 'one:p1',
          active_worktree_id: 'one:w1',
          last_opened_per_project: {
            'two:p2': { worktree_id: 'two:w2', session_id: 'two:s2' },
          },
        },
      })
    ).toBeNull()
  })

  it('decorates project and worktree response identities', () => {
    expect(
      decorateServerResult('r1', 'bootstrap_project', {
        worktrees: [{ id: 'w1', project_id: 'p1', name: 'Worktree' }],
        sessionsByWorktree: { w1: { sessions: [{ id: 's1' }] } },
        runningSessions: ['s1'],
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
      runningSessions: ['r1:s1'],
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

  it('scopes the next active session id returned by close and archive', () => {
    expect(decorateServerResult('r1', 'close_session', 's2')).toBe('r1:s2')
    expect(decorateServerResult('r1', 'archive_session', 's2')).toBe('r1:s2')
    expect(decorateServerResult('r1', 'archive_session', null)).toBeNull()
  })

  it('decorates background investigation session and worktree identities', () => {
    expect(
      decorateServerResult('r1', 'start_background_investigation', {
        sessionId: 's1',
        worktreeId: 'w1',
        status: 'investigation_started',
      })
    ).toEqual({
      sessionId: 'r1:s1',
      worktreeId: 'r1:w1',
      status: 'investigation_started',
    })
  })

  it('strips the scope from ids owned by the target server', () => {
    expect(
      stripServerScope('remote-1', {
        path: '/srv/qrcode',
        parentId: 'remote-1:folder-7',
      })
    ).toEqual({ path: '/srv/qrcode', parentId: 'folder-7' })
  })

  it('keeps ids owned by another server scoped', () => {
    expect(
      stripServerScope('remote-1', { parentId: 'remote-2:folder-7' })
    ).toEqual({ parentId: 'remote-2:folder-7' })
  })

  it('leaves raw ids and missing arguments alone', () => {
    expect(stripServerScope('remote-1', { parentId: 'folder-7' })).toEqual({
      parentId: 'folder-7',
    })
    expect(stripServerScope('remote-1')).toBeUndefined()
  })
})
