import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('TitleBar macOS action insets', () => {
  it('keeps the left inset stable and increases the top inset when zoomed in', () => {
    const titleBar = readFileSync(
      'src/components/titlebar/TitleBar.tsx',
      'utf8'
    )
    const styles = readFileSync('src/App.css', 'utf8')

    expect(titleBar).toContain("'mac-titlebar-actions'")
    expect(styles).toContain(
      'padding-left: var(--mac-titlebar-action-left-inset, 68px);'
    )
    expect(styles).toContain('margin-left: 8px;')
    expect(styles).toContain(
      'padding-top: var(--mac-titlebar-action-top-inset, 4px);'
    )
  })
})
