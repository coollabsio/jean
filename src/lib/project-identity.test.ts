import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/projects'
import {
  collapseProjectsByIdentity,
  findProjectForWorktree,
  normalizeCloneUrl,
} from './project-identity'

const project = (
  overrides: Partial<Project> & Pick<Project, 'id'>
): Project => ({
  name: overrides.id,
  path: `/repos/${overrides.id}`,
  default_branch: 'main',
  added_at: 0,
  order: 0,
  ...overrides,
})

describe('normalizeCloneUrl', () => {
  it('treats ssh and https as the same repository', () => {
    expect(normalizeCloneUrl('https://github.com/coollabsio/jean.git')).toBe(
      'github.com/coollabsio/jean'
    )
    expect(normalizeCloneUrl('git@github.com:coollabsio/jean.git')).toBe(
      'github.com/coollabsio/jean'
    )
    expect(normalizeCloneUrl('ssh://git@github.com:22/coollabsio/jean')).toBe(
      'github.com/coollabsio/jean'
    )
  })
})

describe('collapseProjectsByIdentity', () => {
  it('keeps one row for the same repository and records every host', () => {
    const collapsed = collapseProjectsByIdentity([
      project({
        id: 'local-jean',
        name: 'jean',
        origin_url: 'https://github.com/coollabsio/jean.git',
        worktree_count: 2,
        order: 1,
      }),
      project({
        id: 'remote:jean',
        name: 'jean',
        origin_url: 'git@github.com:coollabsio/jean.git',
        serverId: 'remote-a',
        serverName: 'Build box',
        path: '/srv/jean',
        worktree_count: 1,
        order: 0,
      }),
    ])

    expect(collapsed.map(item => item.id)).toEqual(['local-jean'])
    expect(collapsed[0]?.worktree_count).toBe(3)
    expect(
      collapsed[0]?.hostCheckouts?.map(checkout => checkout.serverId)
    ).toEqual(['local', 'remote-a'])
  })

  it('does not merge different repositories or folders', () => {
    const collapsed = collapseProjectsByIdentity([
      project({
        id: 'jean',
        origin_url: 'https://github.com/coollabsio/jean.git',
      }),
      project({
        id: 'other',
        origin_url: 'https://github.com/acme/other.git',
      }),
      project({ id: 'folder', is_folder: true, path: '' }),
    ])

    expect(collapsed.map(item => item.id).sort()).toEqual([
      'folder',
      'jean',
      'other',
    ])
  })
})

describe('findProjectForWorktree', () => {
  it('finds a collapsed project by a host checkout id', () => {
    const collapsed = collapseProjectsByIdentity([
      project({
        id: 'local-jean',
        origin_url: 'https://github.com/coollabsio/jean.git',
      }),
      project({
        id: 'remote:jean',
        origin_url: 'https://github.com/coollabsio/jean.git',
        serverId: 'remote-a',
        serverName: 'Build box',
      }),
    ])

    const jean = collapsed[0]
    if (!jean) throw new Error('expected one project')
    expect(findProjectForWorktree([jean], 'remote:jean')?.id).toBe('local-jean')
  })
})
