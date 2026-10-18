import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.[jt]sx?$/.test(name)
        ? [path]
        : []
  })

describe('Reicon migration', () => {
  it('does not import Lucide icons in application source', () => {
    const lucideImports = sourceFiles('src').filter(path =>
      readFileSync(path, 'utf8').includes(`from '${['lucide', 'react'].join('-')}'`),
    )

    expect(lucideImports).toEqual([])
  })
})
