import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('browser crypto compatibility', () => {
  it('uses the compatible ID generator instead of randomUUID directly', () => {
    const directUsers = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter(path => path.endsWith('.ts') || path.endsWith('.tsx'))
      .map(path => join('src', path))
      .filter(path => path.replaceAll('\\', '/') !== 'src/lib/uuid.ts')
      .filter(path => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter(path => readFileSync(path, 'utf8').includes('crypto.randomUUID'))

    expect(directUsers).toEqual([])
  })
})
