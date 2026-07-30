import { describe, expect, it } from 'vitest'
import type { Worktree } from '@/types/projects'
import { getCanvasDiffRequest } from './canvas-diff-request'

describe('getCanvasDiffRequest', () => {
  it('uses the worktree base branch and remote', () => {
    const worktree = {
      id: 'wt-1',
      path: '/tmp/worktree',
      base_branch: 'release',
      base_remote: 'fork',
    } as Worktree

    expect(getCanvasDiffRequest(worktree, 'main', 'branch')).toEqual({
      type: 'branch',
      worktreePath: '/tmp/worktree',
      worktreeId: worktree.id,
      baseBranch: 'release',
      baseRemote: 'fork',
    })
  })
})
