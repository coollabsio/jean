import { describe, expect, it } from 'vitest'
import {
  getCanvasHighlight,
  shouldWaitForCanvasRestorePreferences,
} from './ProjectCanvasView'

describe('ProjectCanvasView keyboard navigation', () => {
  it('tracks an empty worktree as the highlighted keyboard row', () => {
    expect(
      getCanvasHighlight({
        worktreeId: 'empty-worktree',
        card: null,
      })
    ).toEqual({
      worktreeId: 'empty-worktree',
      sessionId: undefined,
    })
  })
})

describe('ProjectCanvasView session restoration', () => {
  it('waits for preferences before deciding whether to reopen a session', () => {
    expect(shouldWaitForCanvasRestorePreferences(undefined)).toBe(true)
    expect(
      shouldWaitForCanvasRestorePreferences({ restore_last_session: true })
    ).toBe(false)
  })
})
