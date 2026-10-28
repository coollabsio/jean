import { describe, expect, it } from 'vitest'
import { isStaleActivity } from './worktree-row-status'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

describe('isStaleActivity', () => {
  it('uses the newest timestamp', () => {
    expect(isStaleActivity([NOW - 30 * DAY, NOW - DAY], NOW)).toBe(false)
    expect(isStaleActivity([NOW - 30 * DAY, NOW - 8 * DAY], NOW)).toBe(true)
  })

  it('accepts timestamps stored in seconds', () => {
    expect(isStaleActivity([(NOW - DAY) / 1000], NOW)).toBe(false)
    expect(isStaleActivity([(NOW - 8 * DAY) / 1000], NOW)).toBe(true)
  })

  it('is not stale when no activity is known', () => {
    expect(isStaleActivity([undefined, 0], NOW)).toBe(false)
  })
})
