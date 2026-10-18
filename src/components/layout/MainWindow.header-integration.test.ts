import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('MainWindow header integration', () => {
  it('extends desktop panels and separators behind the title bar', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')

    expect(source).toContain('<div className="flex flex-1 overflow-hidden">')
    expect(
      source.match(/className="h-full overflow-hidden bg-sidebar pt-8"/g)
    ).toHaveLength(1)
    expect(source).toContain(
      'className="h-full overflow-hidden bg-sidebar pt-8 dark:bg-[#0b0b0b]"'
    )
    expect(source).toContain(
      'className="flex min-w-0 flex-1 flex-col overflow-hidden pt-8"'
    )
  })

  it('lets the underlying panel backgrounds and borders show through the title bar', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')

    expect(source).toContain("'bg-transparent md:px-2'")
    expect(source).not.toContain("'bg-background/80 md:px-2'")
  })
})
