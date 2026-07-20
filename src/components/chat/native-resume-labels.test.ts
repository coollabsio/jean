import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceFiles = [
  'src/components/chat/SessionChatModal.tsx',
  'src/components/chat/SessionListRow.tsx',
  'src/components/ui/floating-dock.tsx',
  'src/components/chat/toolbar/MobileSettingsMenu.tsx',
]

describe('native resume command labels', () => {
  it('uses a copy icon with the Native Resume Command label everywhere', () => {
    for (const path of sourceFiles) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source).toMatch(/<Copy[^>]*\/>\s*Native Resume Command/)
      expect(source).not.toContain('Copy Native Resume Command')
    }
  })
})
