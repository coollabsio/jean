import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('command palette clear session context', () => {
  it('targets the session modal before the background active worktree', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/hooks/use-command-context.ts'),
      'utf8'
    )

    expect(source).toContain('uiState.sessionChatModalOpen')
    expect(source).toContain('uiState.sessionChatModalWorktreeId')
    expect(source).toContain(
      "window.dispatchEvent(new CustomEvent('clear-session-context'))"
    )
    expect(source).toContain('worktreePath,')
  })
})
