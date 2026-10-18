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
      'top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[50%] px-2 pt-1'
    )
  })

  it('keeps GitHub and Sponsor out of the mobile header', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/titlebar/TitleBar.tsx'),
      'utf8'
    )

    expect(source).toContain('{native && !isMobile && (')
    expect(source).toContain('{!isMobile && (')
    expect(source).toContain('{!native && !isMobile && (')
  })
})
