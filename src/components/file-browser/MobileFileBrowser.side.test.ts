import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('MobileFileBrowser side', () => {
  it('opens from the right edge', () => {
    const source = readFileSync(
      'src/components/file-browser/MobileFileBrowser.tsx',
      'utf8'
    )

    expect(source).toContain('side="right"')
    expect(source).toContain('border-l')
    expect(source).not.toContain('side="left"')
    expect(source).not.toContain('fileBrowserSwipe')
  })
})
