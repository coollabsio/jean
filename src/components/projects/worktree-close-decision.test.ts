import { describe, expect, it } from 'vitest'
import { isSessionEmpty } from './worktree-close-decision'

describe('isSessionEmpty', () => {
  it('is empty with no messages and no draft', () => {
    expect(isSessionEmpty({ id: 's1', message_count: 0 }, {})).toBe(true)
  })

  it('is empty when the draft has only whitespace', () => {
    expect(isSessionEmpty({ id: 's1' }, { s1: '  \n ' })).toBe(true)
  })

  it('is not empty when an unsent draft exists', () => {
    expect(
      isSessionEmpty({ id: 's1', message_count: 0 }, { s1: 'fix it' })
    ).toBe(false)
  })

  it('ignores drafts of other sessions', () => {
    expect(isSessionEmpty({ id: 's1' }, { s2: 'fix it' })).toBe(true)
  })

  it('is not empty when the session has messages', () => {
    expect(isSessionEmpty({ id: 's1', message_count: 2 }, {})).toBe(false)
  })
})
