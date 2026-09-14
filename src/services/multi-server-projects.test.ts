import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types/projects'
import {
  loadProjectSnapshot,
  loadProjectsForServers,
  saveProjectSnapshot,
  toRoutedProjects,
  type ProjectSnapshotStorage,
} from './multi-server-projects'

const project = (id: string, name: string): Project => ({
  id,
  name,
  path: `/repos/${name}`,
  default_branch: 'main',
  added_at: 1,
  order: 0,
})

function memoryStorage(): ProjectSnapshotStorage {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

describe('multi-server projects', () => {
  it('keeps equal project ids separate by server', async () => {
    const invoke = vi.fn(async (serverId: string) => [
      project('same', serverId),
    ])

    const result = await loadProjectsForServers(
      [
        { serverId: 'r1', name: 'One', online: true },
        { serverId: 'r2', name: 'Two', online: true },
      ],
      invoke,
      memoryStorage()
    )

    expect(result.map(item => item.key)).toEqual(['r1:same', 'r2:same'])
    expect(result.every(item => !item.offline)).toBe(true)
  })

  it('returns a read-only cached snapshot when a server is offline', async () => {
    const storage = memoryStorage()
    saveProjectSnapshot(storage, 'r1', [project('p1', 'Cached')], 123)

    const result = await loadProjectsForServers(
      [{ serverId: 'r1', name: 'One', online: false }],
      vi.fn(),
      storage
    )

    expect(result).toEqual([
      expect.objectContaining({
        key: 'r1:p1',
        serverId: 'r1',
        serverName: 'One',
        offline: true,
        cachedAt: 123,
      }),
    ])
  })

  it('rejects an unknown cache schema', () => {
    const storage = memoryStorage()
    storage.setItem(
      'jean-server-projects:r1',
      JSON.stringify({ schemaVersion: 999, cachedAt: 1, projects: [] })
    )

    expect(loadProjectSnapshot(storage, 'r1')).toBeNull()
  })

  it('converts remote project relations to composite client identities', () => {
    expect(
      toRoutedProjects([
        {
          ...project('child', 'Child'),
          parent_id: 'folder',
          linked_project_ids: ['linked'],
          key: 'r1:child',
          serverId: 'r1',
          serverName: 'One',
          offline: false,
          cachedAt: 1,
        },
      ])
    ).toEqual([
      expect.objectContaining({
        id: 'r1:child',
        resourceId: 'child',
        parent_id: 'r1:folder',
        linked_project_ids: ['r1:linked'],
      }),
    ])
  })
})
