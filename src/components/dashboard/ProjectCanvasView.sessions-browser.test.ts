import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectCanvasView sessions browser wiring', () => {
  const source = readFileSync(
    'src/components/dashboard/ProjectCanvasView.tsx',
    'utf8'
  )

  it('opens the sessions browser when a worktree row is focused', () => {
    expect(source).toContain('WorktreeSessionsBrowser')
    expect(source).toContain('BROWSE_WORKTREE_SESSIONS_EVENT')
    expect(source).toContain('setSessionsBrowser')
    expect(source).toContain('openBrowserSession')
  })

  it('keeps explicit session opens on the session modal', () => {
    expect(source).toContain("'open-session-modal'")
    expect(source).toContain('openWorktreeModal')
  })
})
