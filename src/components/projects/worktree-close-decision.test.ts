import { describe, expect, it } from 'vitest'
import {
  decideWorktreeMiddleClose,
  decideSessionMiddleClose,
} from './worktree-close-decision'

describe('decideWorktreeMiddleClose', () => {
  it('confirms when confirm_session_close is enabled', () => {
    expect(decideWorktreeMiddleClose(true)).toBe('confirm')
  })

  it('confirms when the preference is undefined (defaults to on)', () => {
    expect(decideWorktreeMiddleClose(undefined)).toBe('confirm')
  })

  it('closes immediately when confirm_session_close is disabled', () => {
    expect(decideWorktreeMiddleClose(false)).toBe('close')
  })
})

describe('decideSessionMiddleClose', () => {
  it('confirms when removing the last non-empty session with confirmation on', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 1,
        sessionIsEmpty: false,
        confirmSessionClose: true,
      })
    ).toBe('confirm')
  })

  it('confirms when removing the last non-empty session and preference is undefined', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 1,
        sessionIsEmpty: false,
        confirmSessionClose: undefined,
      })
    ).toBe('confirm')
  })

  it('deletes the last non-empty session when confirmation is disabled', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 1,
        sessionIsEmpty: false,
        confirmSessionClose: false,
      })
    ).toBe('delete')
  })

  it('deletes the last session without confirming when it is empty', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 1,
        sessionIsEmpty: true,
        confirmSessionClose: true,
      })
    ).toBe('delete')
  })

  it('confirms non-empty sessions even when other sessions remain (issue #56)', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 3,
        sessionIsEmpty: false,
        confirmSessionClose: true,
      })
    ).toBe('confirm')
  })

  it('deletes without confirming when other sessions remain (empty)', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 2,
        sessionIsEmpty: true,
        confirmSessionClose: true,
      })
    ).toBe('delete')
  })

  it('confirms a non-empty session even when count is 0 (stale/empty list edge)', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 0,
        sessionIsEmpty: false,
        confirmSessionClose: true,
      })
    ).toBe('confirm')
  })

  it('deletes a non-empty non-last session when confirmation is disabled', () => {
    expect(
      decideSessionMiddleClose({
        activeSessionCount: 3,
        sessionIsEmpty: false,
        confirmSessionClose: false,
      })
    ).toBe('delete')
  })
})
