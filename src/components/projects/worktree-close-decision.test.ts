import { describe, expect, it } from 'vitest'
import {
  decideSessionRowClose,
  isSessionEmpty,
} from './worktree-close-decision'

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

describe('decideSessionRowClose', () => {
  const empty = { id: 's1', message_count: 0 }
  const used = { id: 's1', message_count: 3 }
  const other = { id: 's2' }

  it('asks to delete the worktree for its last session, even when empty', () => {
    expect(decideSessionRowClose(empty, [empty], {})).toBe('confirm-worktree')
    expect(decideSessionRowClose(used, [used], {})).toBe('confirm-worktree')
  })

  it('ignores deleted sessions when it counts the open ones', () => {
    expect(
      decideSessionRowClose(used, [used, { id: 's2', archived_at: 1 }], {})
    ).toBe('confirm-worktree')
  })

  it('closes an empty session at once when other sessions exist', () => {
    expect(decideSessionRowClose(empty, [empty, other], {})).toBe(
      'close-session'
    )
  })

  it('confirms a session with messages or an unsent draft', () => {
    expect(decideSessionRowClose(used, [used, other], {})).toBe(
      'confirm-session'
    )
    expect(decideSessionRowClose(empty, [empty, other], { s1: 'draft' })).toBe(
      'confirm-session'
    )
  })
})
