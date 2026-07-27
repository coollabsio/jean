import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AppearancePane settings structure', () => {
  it('offers collapsed sidebar edge hover in its own section', () => {
    const source = readFileSync(
      'src/components/preferences/panes/AppearancePane.tsx',
      'utf8'
    )

    expect(source).toContain('title="Sidebar"')
    expect(source).toContain('pref-appearance-section-sidebar')
    expect(source).toContain('sidebar_hover_open_enabled')
    expect(source).toContain('Open from screen edge')
  })
})
