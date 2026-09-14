import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectsSidebar server filter', () => {
  it('uses the standard aligned Jean select control', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('className="px-3 pb-1 pt-2"')
    expect(source).toContain('<SelectTrigger')
    expect(source).toContain('aria-label="Filter projects by server"')
    expect(source).toContain('rounded-lg border-border/50 bg-muted/50')
    expect(source).not.toContain('<select')
  })
})
