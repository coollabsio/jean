import { describe, expect, it, vi } from 'vitest'
import type { AllSessionsResponse } from '@/types/chat'
import { loadAllSessionsForServers } from './multi-server-sessions'

function response(project: string): AllSessionsResponse {
  return {
    entries: [
      {
        project_id: `${project}-project`,
        project_name: project,
        worktree_id: `${project}-worktree`,
        worktree_name: 'main',
        worktree_path: `/${project}`,
        sessions: [],
      },
    ],
  }
}

describe('loadAllSessionsForServers', () => {
  it('combines local and online remote sessions and keeps their owners', async () => {
    const invoke = vi.fn(async (serverId: string) => response(serverId))

    const result = await loadAllSessionsForServers(
      [
        { serverId: 'local', name: 'Local', online: true },
        { serverId: 'remote-1', name: 'Build box', online: true },
        { serverId: 'remote-2', name: 'Offline box', online: false },
      ],
      invoke
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(result.entries).toEqual([
      expect.objectContaining({
        project_name: 'local',
        serverId: 'local',
        serverName: 'Local',
      }),
      expect.objectContaining({
        project_name: 'remote-1',
        serverId: 'remote-1',
        serverName: 'Build box',
      }),
    ])
  })

  it('keeps available servers when one request fails', async () => {
    const invoke = vi.fn(async (serverId: string) => {
      if (serverId === 'remote-1') throw new Error('disconnected')
      return response(serverId)
    })

    const result = await loadAllSessionsForServers(
      [
        { serverId: 'local', name: 'Local', online: true },
        { serverId: 'remote-1', name: 'Build box', online: true },
      ],
      invoke
    )

    expect(result.entries.map(entry => entry.project_name)).toEqual(['local'])
  })
})
