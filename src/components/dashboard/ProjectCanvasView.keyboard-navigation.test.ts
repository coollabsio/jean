import { describe, expect, it } from 'vitest'
import { getCanvasHighlight } from './ProjectCanvasView'

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
