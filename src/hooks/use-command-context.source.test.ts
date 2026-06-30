import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('useCommandContext session rename wiring', () => {
  it('falls back to the selected worktree when dispatching rename-session', () => {
    const source = readSource('src/hooks/use-command-context.ts')
    const start = source.indexOf('const renameSession = useCallback(')
    // Anchor on the callback's closing `}, [...])` rather than a comment or
    // blank-line spacing, so harmless refactors above/below don't silently
    // truncate the extracted body to '' and mask a real regression.
    const close = source.indexOf('\n  }, [', start)
    const end = close === -1 ? -1 : source.indexOf(')', close)
    const renameSession =
      start === -1 || end === -1 ? '' : source.slice(start, end)

    expect(renameSession).toContain('useProjectsStore.getState().selectedWorktreeId')
    expect(renameSession).toContain("new CustomEvent('command:rename-session'")
  })
})
