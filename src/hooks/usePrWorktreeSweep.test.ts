import { describe, expect, it } from 'vitest'
import { resolveSweepBaseBranch } from './usePrWorktreeSweep'

describe('resolveSweepBaseBranch', () => {
  it('uses the worktree base when set (e.g. v4.x on coolify)', () => {
    expect(
      resolveSweepBaseBranch(
        { base_branch: 'v4.x' },
        { default_branch: 'next' }
      )
    ).toBe('v4.x')
  })

  it('falls back to the project default when the worktree has no base', () => {
    expect(
      resolveSweepBaseBranch(
        { base_branch: undefined },
        { default_branch: 'next' }
      )
    ).toBe('next')
  })
})
