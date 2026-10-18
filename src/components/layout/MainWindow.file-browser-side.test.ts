import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('MainWindow file-browser side', () => {
  it('places the desktop file browser after the main content', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')
    const mainContent = source.indexOf(
      '{/* Main Content + bottom browser panel stacked vertically */}'
    )
    const resizeHandle = source.indexOf(
      '{/* Desktop: resize handle for file browser */}'
    )
    const fileBrowser = source.indexOf('{/* Desktop: file browser sidebar */}')

    expect(resizeHandle).toBeGreaterThan(mainContent)
    expect(fileBrowser).toBeGreaterThan(resizeHandle)
  })

  it('grows the right-side file browser when its left edge moves left', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')

    expect(source).toContain('const delta = startX - moveEvent.clientX')
  })
})
