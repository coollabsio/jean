import { describe, expect, it } from 'vitest'
import type { Worktree } from '@/types/projects'
import { resolveModalWorktreeSnapshot } from './modal-worktree-snapshot'

const worktree = (id: string, name: string): Worktree =>
  ({ id, name, path: `/${name}` }) as Worktree

describe('resolveModalWorktreeSnapshot', () => {
  it('keeps the selected worktree while a server switch briefly clears query data', () => {
    const local = worktree('local-worktree', 'main')

    expect(resolveModalWorktreeSnapshot('local-worktree', [], local)).toBe(
      local
    )
  })

  it('does not reuse a snapshot for a different selected worktree', () => {
    const remote = worktree('remote:worktree', 'remote-main')

    expect(
      resolveModalWorktreeSnapshot('local-worktree', [], remote)
    ).toBeNull()
  })
})
