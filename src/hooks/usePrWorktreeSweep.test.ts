import { describe, expect, it } from 'vitest'
import {
  RECENT_WORKTREE_ACTIVITY_SECS,
  resolveSweepBaseBranch,
  shouldIncludeInGitSweep,
} from './usePrWorktreeSweep'

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

describe('shouldIncludeInGitSweep', () => {
  const now = 1_000_000
  const cleanInactive = {
    pr_number: undefined,
    pr_url: undefined,
    cached_status_at: now - RECENT_WORKTREE_ACTIVITY_SECS - 1,
    cached_uncommitted_added: 0,
    cached_uncommitted_removed: 0,
    cached_unpushed_count: 0,
    cached_worktree_ahead_count: 0,
    last_opened_at: now - RECENT_WORKTREE_ACTIVITY_SECS - 1,
  }

  it('keeps never-checked worktrees in the sweep', () => {
    expect(
      shouldIncludeInGitSweep({ ...cleanInactive, cached_status_at: undefined }, now)
    ).toBe(true)
  })

  it('skips clean worktrees outside the recent activity window', () => {
    expect(shouldIncludeInGitSweep(cleanInactive, now)).toBe(false)
  })

  it('keeps recently opened and locally changed worktrees', () => {
    expect(
      shouldIncludeInGitSweep(
        { ...cleanInactive, last_opened_at: now - 60 },
        now
      )
    ).toBe(true)
    expect(
      shouldIncludeInGitSweep(
        { ...cleanInactive, cached_unpushed_count: 1 },
        now
      )
    ).toBe(true)
  })

  it('always keeps worktrees with an open PR', () => {
    expect(
      shouldIncludeInGitSweep(
        { ...cleanInactive, pr_number: 42, pr_url: 'https://github.com/org/repo/pull/42' },
        now
      )
    ).toBe(true)
  })
})
