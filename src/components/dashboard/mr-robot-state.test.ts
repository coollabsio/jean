import { describe, expect, it } from 'vitest'
import type { AutoFixStatus, Worktree } from '@/types/projects'
import type {
  SessionCardData,
  SessionStatus,
} from '@/components/chat/session-card-utils'
import {
  formatRobotTime,
  getRobotStatus,
  getRobotWorktreeState,
} from './mr-robot-state'

const worktree = {
  id: 'robot',
  origin: 'auto_fix',
  status: 'ready',
} as Worktree
const card = (status: SessionStatus) =>
  ({ status, session: { id: status } }) as SessionCardData
const status: AutoFixStatus = {
  lastScanAt: null,
  nextScanAt: null,
  rateLimitedUntil: null,
  lastError: null,
  failedIssues: [],
  startingIssues: [],
  pendingYoloSessions: 0,
}

describe('Mr. Robot state', () => {
  it('opens the session that needs approval instead of an unrelated completed session', () => {
    const approval = card('plan_approval')
    expect(
      getRobotWorktreeState(worktree, [card('completed'), approval])
    ).toMatchObject({
      label: 'Awaiting approval',
      card: approval,
      needsAttention: true,
      active: false,
    })
  })
  it('counts a worktree as active even when a different session awaits approval', () => {
    expect(
      getRobotWorktreeState(worktree, [card('plan_approval'), card('yoloing')])
    ).toMatchObject({ active: true, needsAttention: true })
  })
  it('does not report a merged PR as ready for merge', () => {
    expect(
      getRobotWorktreeState(
        {
          ...worktree,
          pr_url: 'https://github.com/test/repo/pull/1',
          cached_pr_status: 'MERGED',
        },
        []
      )
    ).toMatchObject({ label: 'PR merged', action: 'Open PR' })
  })
  it('does not report an existing PR as ready while a new turn is running', () => {
    expect(
      getRobotWorktreeState(
        { ...worktree, pr_url: 'https://github.com/test/repo/pull/1' },
        [card('yoloing')]
      )
    ).toMatchObject({ label: 'Building', active: true })
  })
  it('keeps pending creation active and reports failed creation as actionable', () => {
    expect(
      getRobotWorktreeState({ ...worktree, status: 'pending' }, [])
    ).toMatchObject({ active: true, needsAttention: false })
    expect(
      getRobotWorktreeState({ ...worktree, status: 'error' }, [])
    ).toMatchObject({ active: false, needsAttention: true })
  })
  it('does not count a completed result as an active run or claim it has a PR', () => {
    expect(getRobotWorktreeState(worktree, [card('completed')])).toMatchObject({
      label: 'Ready for review',
      active: false,
    })
  })
  it('uses server active hours and only treats a future rate limit as current', () => {
    expect(getRobotStatus(true, { ...status, activeNow: false }, [], 100)).toBe(
      'Outside active hours'
    )
    expect(
      getRobotStatus(true, { ...status, rateLimitedUntil: 101 }, [], 100)
    ).toBe('Rate limited')
    expect(
      getRobotStatus(true, { ...status, rateLimitedUntil: 99 }, [], 100)
    ).toBe('Idle')
  })
  it('shows off when paused without changing the active session state', () => {
    const building = getRobotWorktreeState(worktree, [card('yoloing')])
    expect(getRobotStatus(false, status, [building], 100)).toBe('Off')
    expect(building.active).toBe(true)
  })
  it('gives errors and approval requests priority over idle or running summaries', () => {
    expect(
      getRobotStatus(
        true,
        { ...status, lastError: { message: 'failed', at: 1 } },
        [],
        100
      )
    ).toBe('Needs attention')
    expect(
      getRobotStatus(
        true,
        status,
        [getRobotWorktreeState(worktree, [card('permission')])],
        100
      )
    ).toBe('Needs attention')
  })
  it('formats timestamps in seconds and handles absent or future scans', () => {
    expect(formatRobotTime(null, 1000)).toBe('Not yet')
    expect(formatRobotTime(940, 1000)).toBe('1 min ago')
    expect(formatRobotTime(1120, 1000)).toBe('in 2 min')
  })
})
