import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('MainWindow zen title', () => {
  it('keeps the worktree in the desktop window title during zen mode', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/layout/MainWindow.tsx'),
      'utf8'
    )

    expect(source).toContain('if (isMobile) return project.name')
    expect(source).not.toContain('if (isMobile || zenMode)')
  })
})
