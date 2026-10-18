import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('View plan removal', () => {
  it('does not expose the menu action or open-plan event path', () => {
    const sources = [
      'src/components/chat/SessionListRow.tsx',
      'src/components/chat/hooks/useCanvasShortcutEvents.ts',
      'src/components/chat/hooks/useChatWindowEvents.ts',
      'src/hooks/useMainWindowEventListeners.ts',
      'src/types/keybindings.ts',
    ].map(read)

    for (const source of sources) {
      expect(source).not.toContain('View Plan')
      expect(source).not.toContain('open-plan')
      expect(source).not.toContain("'open_plan'")
    }
  })
})
