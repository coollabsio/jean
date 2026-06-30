import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('useCommandContext session rename wiring', () => {
  it('falls back to the selected worktree when dispatching rename-session', () => {
    const source = readSource('src/hooks/use-command-context.ts')
    const start = source.indexOf('const renameSession = useCallback(')
    const end = source.indexOf('\n\n  // Worktrees - Create new worktree', start)
    const renameSession = start === -1 || end === -1 ? '' : source.slice(start, end)

    expect(renameSession).toContain('useProjectsStore.getState().selectedWorktreeId')
    expect(renameSession).toContain("new CustomEvent('command:rename-session'")
  })
})
