import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/components/chat/ChatWindow.tsx'),
  'utf8'
)

describe('ChatWindow zen composer', () => {
  it('places the action toolbar beside the textarea', () => {
    expect(source).toContain("'flex max-h-16 items-center overflow-hidden'")
    expect(source).toContain("zenMode && 'min-w-0 flex-1'")
    expect(source).toContain('zenMode && isMobile ? (')
    expect(source).toContain('<SendCancelButton')
    expect(source).toContain('<ChatToolbar')
  })

  it('hides old-prompt loading controls in zen mode', () => {
    expect(source).toContain('hasOlderOnDisk={!zenMode && hasOlderOnDisk}')
    expect(source).toContain('zenMode || isCompactHistoryExpanded')
    expect(source).toMatch(
      /onShowHiddenPrompts=\{\s*zenMode\s*\? undefined\s*:\s*handleShowHiddenCompactPrompts\s*\}/
    )
  })
})
