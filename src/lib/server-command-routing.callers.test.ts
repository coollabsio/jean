import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PATH_ARGUMENT_KEYS,
  ROUTED_ARGUMENT_KEYS,
} from './server-command-routing'

/**
 * Two Jean servers can own the same absolute path. A path alone then cannot
 * name its server, so routing rejects it as ambiguous. Every direct `invoke`
 * that sends a repository path must also send the owning resource id.
 * `invokeForServer` / `invokeForOptionalServer` name the server themselves.
 */
const SRC = join(process.cwd(), 'src')
const keyPattern = (keys: ReadonlySet<string>) =>
  new RegExp(`\\b(${[...keys].join('|')})\\b`)
const PATH_KEY = keyPattern(PATH_ARGUMENT_KEYS)
const OWNER_KEY = keyPattern(ROUTED_ARGUMENT_KEYS)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })
}

/** `file:line command` for each direct invoke with a path and no owner id. */
function pathOnlyInvokes(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\binvoke\s*(?:<[^()]*?>)?\s*\(/g)) {
      let end = match.index + match[0].length
      for (let depth = 1; end < source.length && depth > 0; end++) {
        if (source[end] === '(') depth++
        else if (source[end] === ')') depth--
      }
      const call = source.slice(match.index, end)
      if (!PATH_KEY.test(call) || OWNER_KEY.test(call)) continue
      const line = source.slice(0, match.index).split('\n').length
      const command = call.match(/['"`]([a-z0-9_]+)['"`]/)?.[1]
      found.push(`${relative(SRC, file)}:${line} ${command}`)
    }
  }
  return found
}

describe('path-based command callers', () => {
  it('send the owning resource id with every repository path', () => {
    expect(pathOnlyInvokes()).toEqual([])
  })
})
