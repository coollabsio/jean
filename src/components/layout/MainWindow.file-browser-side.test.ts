import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('MainWindow file-browser side', () => {
  it('places the desktop right panel after the main content', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')
    const mainContent = source.indexOf('{/* Main Content */}')
    const resizeHandle = source.indexOf(
      '{/* Desktop: resize handle for the right panel */}'
    )
    const fileBrowser = source.indexOf(
      '{/* Desktop: right panel (files, terminal, browser) */}'
    )

    expect(resizeHandle).toBeGreaterThan(mainContent)
    expect(fileBrowser).toBeGreaterThan(resizeHandle)
  })

  it('grows the right panel when its left edge moves left', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')

    expect(source).toContain('const delta = startX - moveEvent.clientX')
  })
})
