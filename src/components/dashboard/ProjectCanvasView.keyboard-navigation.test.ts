import { describe, expect, it } from 'vitest'
import type { SessionCardData } from '@/components/chat/session-card-utils'
import {
  findCanvasHighlightIndex,
  getCanvasHighlight,
} from './ProjectCanvasView'

const row = (worktreeId: string, sessionId: string | null) => ({
  worktreeId,
  card: sessionId
    ? ({ session: { id: sessionId } } as unknown as SessionCardData)
    : null,
})

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

  it('selects the exact session row when a worktree has one row per session', () => {
    const rows = [row('a', 'a1'), row('b', 'b1'), row('b', 'b2')]
    expect(
      findCanvasHighlightIndex(rows, { worktreeId: 'b', sessionId: 'b2' })
    ).toBe(2)
  })

  it('falls back to the worktree row when the session has no row', () => {
    const rows = [row('a', 'a1'), row('b', 'b1')]
    expect(
      findCanvasHighlightIndex(rows, { worktreeId: 'b', sessionId: 'b9' })
    ).toBe(1)
    expect(findCanvasHighlightIndex(rows, { worktreeId: 'b' })).toBe(1)
    expect(findCanvasHighlightIndex(rows, { worktreeId: 'z' })).toBe(-1)
  })
})
