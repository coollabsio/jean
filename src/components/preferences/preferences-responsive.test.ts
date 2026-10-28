import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const RESPONSIVE_FILES = [
  'src/components/preferences/PreferencesDialog.tsx',
  'src/components/preferences/panes/GeneralPane.tsx',
  'src/components/preferences/panes/AppearancePane.tsx',
  'src/components/preferences/panes/TerminalPane.tsx',
  'src/components/preferences/panes/WebAccessPane.tsx',
  'src/components/preferences/panes/BackendProviders.tsx',
  'src/components/preferences/panes/BackendsPane.tsx',
]

describe('Preferences responsive layout', () => {
  it('does not use fixed 24rem settings labels or controls that overflow native narrow windows', () => {
    for (const file of RESPONSIVE_FILES) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/\bsm:(?:min-)?w-96\b|\bw-96\b/)
    }
  })

  it('wraps multi-select execution setting grids before they overflow the dialog', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )

    expect(source).not.toContain('grid grid-cols-4 gap-2')
    expect(source).toContain(
      'grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4'
    )
  })
})
