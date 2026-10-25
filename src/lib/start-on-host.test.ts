import { describe, expect, it, vi } from 'vitest'
import {
  envFilesToOffer,
  startProjectOnHost,
  StartOnHostCancelled,
} from './start-on-host'

const project = {
  id: 'local-jean',
  name: 'jean',
  path: '/repos/jean',
  serverName: 'Local',
  hostCheckouts: [
    {
      serverId: 'local',
      projectId: 'local-jean',
      path: '/repos/jean',
      serverName: 'Local',
    },
  ],
}

function deps(
  invoke: (
    serverId: string,
    command: string,
    args?: Record<string, unknown>
  ) => Promise<unknown>
) {
  return {
    invoke,
    confirmEnvCopy: vi.fn(async () => 'skip' as const),
    onProgress: vi.fn(),
  }
}

describe('startProjectOnHost', () => {
  it('clones when the target host has no checkout', async () => {
    const invoke = vi.fn(async (serverId: string, command: string) => {
      if (command === 'list_clone_urls') {
        return ['https://github.com/coollabsio/jean.git']
      }
      if (command === 'ensure_project_present') {
        return {
          status: 'cloned',
          project: { id: 'remote:jean', path: '/srv/jean' },
        }
      }
      if (command === 'list_project_env_files') return []
      throw new Error(`unexpected ${serverId} ${command}`)
    })
    const client = deps(invoke)

    const result = await startProjectOnHost(
      {
        project,
        targetServerId: 'remote-a',
        targetServerName: 'Build box',
        targetOnline: true,
      },
      client
    )

    expect(result).toMatchObject({
      projectId: 'remote:jean',
      projectPath: '/srv/jean',
      status: 'cloned',
    })
    expect(invoke).toHaveBeenCalledWith('remote-a', 'ensure_project_present', {
      cloneUrls: ['https://github.com/coollabsio/jean.git'],
      name: 'jean',
    })
    expect(client.confirmEnvCopy).not.toHaveBeenCalled()
    expect(client.onProgress).toHaveBeenCalledWith(
      'Cloning jean onto Build box…'
    )
  })

  it('skips clone when the target host already has the checkout', async () => {
    const invoke = vi.fn(async (_serverId: string, command: string) => {
      if (command === 'list_project_env_files') return ['.env']
      throw new Error(`unexpected ${command}`)
    })

    const result = await startProjectOnHost(
      {
        project: {
          ...project,
          hostCheckouts: [
            ...project.hostCheckouts,
            {
              serverId: 'remote-a',
              projectId: 'remote:jean',
              path: '/srv/jean',
              serverName: 'Build box',
            },
          ],
        },
        targetServerId: 'remote-a',
        targetServerName: 'Build box',
        targetOnline: true,
      },
      deps(invoke)
    )

    expect(result).toMatchObject({
      projectId: 'remote:jean',
      status: 'present',
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'remote-a',
      'ensure_project_present',
      expect.anything()
    )
    expect(invoke.mock.calls.some(call => call[1] === 'list_clone_urls')).toBe(
      false
    )
  })

  it('asks before copying env files the target does not have', async () => {
    const invoke = vi.fn(
      async (
        serverId: string,
        command: string,
        args?: Record<string, unknown>
      ) => {
        if (command === 'list_project_env_files' && serverId === 'remote-a') {
          return []
        }
        if (command === 'list_project_env_files' && serverId === 'local') {
          return ['.env', '.env.local']
        }
        if (command === 'read_project_env_files') {
          return [
            { name: '.env', contents: 'TOKEN=1' },
            { name: '.env.local', contents: 'LOCAL=1' },
          ]
        }
        if (command === 'write_project_env_files') return null
        throw new Error(
          `unexpected ${serverId} ${command} ${JSON.stringify(args)}`
        )
      }
    )
    const confirmEnvCopy = vi.fn(async () => 'copy' as const)

    await startProjectOnHost(
      {
        project: {
          ...project,
          hostCheckouts: [
            ...project.hostCheckouts,
            {
              serverId: 'remote-a',
              projectId: 'remote:jean',
              path: '/srv/jean',
              serverName: 'Build box',
            },
          ],
        },
        targetServerId: 'remote-a',
        targetServerName: 'Build box',
        targetOnline: true,
      },
      { invoke, confirmEnvCopy }
    )

    expect(confirmEnvCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceServerId: 'local',
        sourceServerName: 'Local',
        files: ['.env', '.env.local'],
      })
    )
    expect(invoke).toHaveBeenCalledWith('local', 'read_project_env_files', {
      projectPath: '/repos/jean',
      names: ['.env', '.env.local'],
    })
    expect(invoke).toHaveBeenCalledWith(
      'remote-a',
      'write_project_env_files',
      expect.objectContaining({ projectPath: '/srv/jean' })
    )
  })

  it('does not copy env files when the user skips', async () => {
    const invoke = vi.fn(async (serverId: string, command: string) => {
      if (command === 'list_project_env_files') {
        return serverId === 'local' ? ['.env'] : []
      }
      throw new Error(`unexpected ${command}`)
    })
    const confirmEnvCopy = vi.fn(async () => 'skip' as const)

    await startProjectOnHost(
      {
        project: {
          ...project,
          hostCheckouts: [
            ...project.hostCheckouts,
            {
              serverId: 'remote-a',
              projectId: 'remote:jean',
              path: '/srv/jean',
              serverName: 'Build box',
            },
          ],
        },
        targetServerId: 'remote-a',
        targetServerName: 'Build box',
        targetOnline: true,
      },
      { invoke, confirmEnvCopy }
    )

    expect(
      invoke.mock.calls.some(call => call[1] === 'read_project_env_files')
    ).toBe(false)
  })

  it('reports a connection failure before cloning', async () => {
    const invoke = vi.fn()
    await expect(
      startProjectOnHost(
        {
          project,
          targetServerId: 'remote-a',
          targetServerName: 'Build box',
          targetOnline: false,
          targetError: 'Connection refused',
        },
        deps(invoke)
      )
    ).rejects.toThrow(/Can't reach Build box.*Connection refused/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('stops when env copy is cancelled', async () => {
    const invoke = vi.fn(async (serverId: string, command: string) => {
      if (command === 'list_project_env_files') {
        return serverId === 'local' ? ['.env'] : []
      }
      throw new Error(`unexpected ${command}`)
    })

    await expect(
      startProjectOnHost(
        {
          project: {
            ...project,
            hostCheckouts: [
              ...project.hostCheckouts,
              {
                serverId: 'remote-a',
                projectId: 'remote:jean',
                path: '/srv/jean',
                serverName: 'Build box',
              },
            ],
          },
          targetServerId: 'remote-a',
          targetServerName: 'Build box',
          targetOnline: true,
        },
        { invoke, confirmEnvCopy: async () => 'cancel' }
      )
    ).rejects.toBeInstanceOf(StartOnHostCancelled)
  })
})

describe('envFilesToOffer', () => {
  it('offers only files the target does not already have', () => {
    expect(
      envFilesToOffer(
        ['.env'],
        [
          {
            serverId: 'local',
            serverName: 'Local',
            projectPath: '/repos/jean',
            files: ['.env', '.env.local'],
          },
        ]
      )?.files
    ).toEqual(['.env.local'])
  })
})
