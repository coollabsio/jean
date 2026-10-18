import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('MainWindow sidebar separators', () => {
  it('uses the same subdued border color as the project sidebar divider', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')

    expect(source).toContain(
      'className="relative h-full w-px bg-border/40"'
    )
    expect(source).toContain(
      'className="relative z-20 h-full w-px shrink-0 cursor-col-resize bg-border/40"'
    )
    expect(source).not.toContain(
      'className="relative h-full w-px bg-border"'
    )
  })

  it('keeps the file browser resize hit area above both adjacent panels', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')

    expect(source).toContain(
      'className="absolute inset-y-0 z-20 -left-1.5 -right-1.5 cursor-col-resize"'
    )
  })
})
