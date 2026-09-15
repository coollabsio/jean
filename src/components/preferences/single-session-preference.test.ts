import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('removed single session per worktree preference', () => {
  it('removes the preference and its behavior from frontend and backend', () => {
    const sources = [
      'src/types/preferences.ts',
      'src/components/preferences/panes/ExperimentalPane.tsx',
      'src/components/preferences/preferences-search.ts',
      'src/components/chat/SessionChatModal.tsx',
      'src/components/titlebar/TitleBar.tsx',
      'jean-core/src/lib.rs',
      'jean-core/src/chat/commands.rs',
      'src/services/preferences.test.ts',
    ]

    for (const source of sources) {
      expect(readSource(source)).not.toContain('single_session_per_worktree')
    }
  })
})
