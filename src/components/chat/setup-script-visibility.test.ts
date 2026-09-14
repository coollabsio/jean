import { describe, expect, it } from 'vitest'
import { isFirstWorktreeSession } from './setup-script-visibility'

describe('isFirstWorktreeSession', () => {
  it('shows setup status only in the earliest session', () => {
    const sessions = [
      { id: 'later', order: 1, created_at: 20 },
      { id: 'first', order: 0, created_at: 10 },
    ]

    expect(isFirstWorktreeSession('first', sessions)).toBe(true)
    expect(isFirstWorktreeSession('later', sessions)).toBe(false)
  })
})
