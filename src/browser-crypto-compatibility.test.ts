import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('browser crypto compatibility', () => {
  it('uses the compatible ID generator instead of randomUUID directly', () => {
    const directUsers = globSync('src/**/*.{ts,tsx}')
      .filter(path => !path.endsWith('src/lib/uuid.ts'))
      .filter(path => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter(path => readFileSync(path, 'utf8').includes('crypto.randomUUID'))

    expect(directUsers).toEqual([])
  })
})
