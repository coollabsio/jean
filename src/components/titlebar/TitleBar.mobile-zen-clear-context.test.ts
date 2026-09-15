import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TitleBar mobile zen actions', () => {
  it('keeps only the exit zen action', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/titlebar/TitleBar.tsx'),
      'utf8'
    )

    expect(source).toContain('data-testid="toggle-zen-mode"')
    expect(source).not.toContain('data-testid="clear-session-context"')
    expect(source).not.toContain('aria-label="Clear context"')
    expect(source).not.toContain('showMobileZenClearContext')
  })
})
