import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SessionChatModal separators', () => {
  it('uses the subdued sidebar separator color for session boundaries', () => {
    const source = readFileSync(
      'src/components/chat/SessionChatModal.tsx',
      'utf8'
    )

    expect(source).toContain('shrink-0 border-b border-border/40 sm:text-left')
    expect(source).toContain(
      'items-center gap-0.5 border-b border-border/40 pr-4'
    )
    expect(source).toContain('border-r border-border/40 px-3')
  })
})
