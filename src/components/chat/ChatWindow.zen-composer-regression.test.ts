import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/components/chat/ChatWindow.tsx'),
  'utf8'
)

describe('ChatWindow zen composer', () => {
  it('places the action toolbar beside the textarea', () => {
    expect(source).toContain("zenMode && 'max-h-20'")
    expect(source).toContain("zenMode && 'min-w-0 flex-1'")
    expect(source).toContain('zenMode ? (')
    expect(source).toContain('<SendCancelButton')
    expect(source).toContain('<ChatToolbar')
  })

  it('leaves enough height for two input lines in zen mode', () => {
    const inputSource = readFileSync(
      join(process.cwd(), 'src/components/chat/ChatInput.tsx'),
      'utf8'
    )

    expect(inputSource).toContain("zenMode ? 'h-12 max-h-12'")
  })

  it('hides old-prompt loading controls in zen mode', () => {
    expect(source).toContain('hasOlderOnDisk={!zenMode && hasOlderOnDisk}')
    expect(source).toContain('zenMode || isCompactHistoryExpanded')
    expect(source).toMatch(
      /onShowHiddenPrompts=\{\s*zenMode\s*\? undefined\s*:\s*handleShowHiddenCompactPrompts\s*\}/
    )
  })

  it('exposes the composer so mobile toasts can sit above the textarea', () => {
    expect(source).toContain('data-chat-composer=')
    expect(source).toContain('setChatComposerNode')
    expect(source).toContain('registerChatComposer')
  })

  it('hides tasks and agents bars in zen mode', () => {
    expect(source).toMatch(/\{!zenMode &&\s*activeTodos\.length > 0 &&/)
    expect(source).toMatch(/\{!zenMode &&\s*activeAgents\.length > 0 &&/)
    expect(source).toMatch(
      /\{!zenMode &&\s*!terminalPanelOpen &&\s*\(activeTodos\.length > 0 \|\|/
    )
  })
})
