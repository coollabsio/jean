import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/components/chat/ChatWindow.tsx'),
  'utf8'
)

describe('ChatWindow context controls', () => {
  it('does not render loaded issue and pull request chips above the input', () => {
    expect(source).not.toContain(
      "import { ContextPreview } from './ContextPreview'"
    )
    expect(source).not.toContain('<ContextPreview')
  })

  it('keeps loaded contexts in the toolbar submenu', () => {
    expect(source).toContain('loadedIssueContexts={loadedIssueContexts ?? []}')
    expect(source).toContain('loadedPRContexts={loadedPRContexts ?? []}')
  })
})
