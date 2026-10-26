import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/projects'
import { filterProjectsByServer } from './server-filter'

const project = (id: string, serverId?: string): Project => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  default_branch: 'main',
  added_at: 0,
  order: 0,
  serverId,
})

describe('filterProjectsByServer', () => {
  const projects = [project('local'), project('remote:a', 'remote')]

  it('shows every server by default', () => {
    expect(filterProjectsByServer(projects, 'all')).toEqual(projects)
  })

  it('treats existing projects as local and filters remote projects', () => {
    expect(
      filterProjectsByServer(projects, 'local').map(item => item.id)
    ).toEqual(['local'])
    expect(
      filterProjectsByServer(projects, 'remote').map(item => item.id)
    ).toEqual(['remote:a'])
  })

  it('keeps a collapsed project when filtering to a host that has a checkout', () => {
    const shared = project('local', 'local')
    shared.hostCheckouts = [
      {
        serverId: 'local',
        projectId: 'local',
        path: '/tmp/local',
        serverName: 'Local',
      },
      {
        serverId: 'remote',
        projectId: 'remote:a',
        path: '/srv/a',
        serverName: 'Build box',
      },
    ]
    expect(
      filterProjectsByServer([shared], 'remote').map(item => item.id)
    ).toEqual(['local'])
  })
})
