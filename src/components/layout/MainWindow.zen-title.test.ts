import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('MainWindow title', () => {
  it('hides the title text in the desktop title bar (native and web)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/layout/MainWindow.tsx'),
      'utf8'
    )

    const title = readFileSync(
      join(process.cwd(), 'src/components/layout/window-title.tsx'),
      'utf8'
    )

    expect(title).toContain('if (isMobile) return projectName')
    expect(source).not.toContain('if (isMobile || zenMode)')
    expect(title).not.toContain('zenMode')
    expect(source).toContain('hideTitle={!isMobile}')
  })
})
