import { describe, expect, it } from 'vitest'
import { sessionRowTitle } from './session-title'

describe('sessionRowTitle', () => {
  it('shows the worktree name for the only session with a default name', () => {
    expect(sessionRowTitle('Session 1', 'fix-login', 1)).toBe('fix-login')
    expect(sessionRowTitle('Session 3', 'fix-login', 1)).toBe('fix-login')
  })

  it('keeps default names when the worktree has more open sessions', () => {
    expect(sessionRowTitle('Session 1', 'fix-login', 2)).toBe('Session 1')
  })

  it('keeps a real session name', () => {
    expect(sessionRowTitle('Fix login redirect', 'fix-login', 1)).toBe(
      'Fix login redirect'
    )
    expect(sessionRowTitle('Session 1 notes', 'fix-login', 1)).toBe(
      'Session 1 notes'
    )
  })
})
