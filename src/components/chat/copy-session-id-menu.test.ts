import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceFiles = [
  'src/components/chat/SessionChatModal.tsx',
  'src/components/chat/SessionListRow.tsx',
]

describe('copy session ID context menu', () => {
  it('exposes Copy Session ID on session right-click menus', () => {
    for (const path of sourceFiles) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source).toContain('Copy Session ID')
      expect(source).toMatch(/copyToClipboard\((?:card\.)?session\.id\)/)
      expect(source).toContain("toast.success('Session ID copied')")
    }
  })
})
