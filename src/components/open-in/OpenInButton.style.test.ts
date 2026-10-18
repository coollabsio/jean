import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OpenInButton styling', () => {
  it('keeps the split control at the same outer height as adjacent buttons', () => {
    const source = readFileSync(
      'src/components/open-in/OpenInButton.tsx',
      'utf8'
    )

    expect(source).toContain('hidden h-7 items-center')
    expect(source.match(/className="h-full/g)).toHaveLength(2)
  })
})
