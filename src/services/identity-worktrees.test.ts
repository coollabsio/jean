import { describe, expect, it } from 'vitest'
import type { Worktree } from '@/types/projects'
import { mergeHostWorktrees } from './identity-worktrees'

const worktree = (id: string): Worktree =>
  ({
    id,
    project_id: 'project',
    name: id,
    path: `/tmp/${id}`,
    branch: id,
    created_at: 0,
  }) as Worktree

describe('mergeHostWorktrees', () => {
  it('labels worktrees when the project exists on more than one host', () => {
    const merged = mergeHostWorktrees(
      [
        { serverId: 'local', serverName: 'Local' },
        { serverId: 'remote-a', serverName: 'Build box' },
      ],
      [[worktree('local-wt')], [worktree('remote-wt')]]
    )

    expect(merged.map(item => [item.id, item.serverName])).toEqual([
      ['local-wt', 'Local'],
      ['remote-wt', 'Build box'],
    ])
  })

  it('leaves a single host unlabeled', () => {
    const merged = mergeHostWorktrees(
      [{ serverId: 'local', serverName: 'Local' }],
      [[worktree('only')]]
    )
    expect(merged[0]?.serverName).toBeUndefined()
  })
})
