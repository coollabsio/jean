import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TitleBar mobile alignment', () => {
  it('uses the same top offset for the centered status and side actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/titlebar/TitleBar.tsx'),
      'utf8'
    )

    expect(source).toContain(
      'absolute inset-0 flex items-center justify-center pt-1'
    )
  })
})
