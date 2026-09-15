import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/projects'
import { groupProjectsByServer } from './project-server-sections'

const project = (id: string, serverId?: string, serverName?: string) =>
  ({ id, name: id, serverId, serverName }) as Project

describe('groupProjectsByServer', () => {
  it('creates one local section and one title for each remote server', () => {
    const sections = groupProjectsByServer([
      project('local-1'),
      project('remote-1', 'dev', 'Dev Server'),
      project('remote-2', 'dev', 'Dev Server'),
    ])

    expect(sections.map(section => section.title)).toEqual([
      'Local',
      'Dev Server',
    ])
    expect(sections[1]?.projects.map(item => item.id)).toEqual([
      'remote-1',
      'remote-2',
    ])
  })
})
