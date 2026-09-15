import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rustSource = readFileSync(
  join(process.cwd(), 'jean-core/src/lib.rs'),
  'utf8'
)
const typescriptSource = readFileSync(
  join(process.cwd(), 'src/types/preferences.ts'),
  'utf8'
)

function rustPrompt(functionName: string): string {
  const match = rustSource.match(
    new RegExp(
      `fn ${functionName}\\(\\) -> String \\{\\s*r#"([\\s\\S]*?)"#\\s*\\.to_string\\(\\)\\s*\\}`
    )
  )
  expect(
    match,
    `${functionName} should be a Rust raw-string default`
  ).not.toBeNull()
  return match?.[1] ?? ''
}

describe('shared magic prompt defaults', () => {
  const prompts = Array.from(
    typescriptSource.matchAll(
      /export const DEFAULT_([A-Z0-9_]+)_PROMPT = `((?:\\`|[^`])*)`/g
    )
  )
    .map(match => [
      `default_${match[1]?.toLowerCase()}_prompt`,
      (match[2] ?? '').replaceAll('\\`', '`'),
    ])
    .filter(([functionName]) => rustSource.includes(`fn ${functionName}()`))

  it.each(prompts)(
    'keeps %s identical in Rust and TypeScript',
    (functionName, prompt) => {
      expect(rustPrompt(functionName)).toBe(prompt)
    }
  )
})
