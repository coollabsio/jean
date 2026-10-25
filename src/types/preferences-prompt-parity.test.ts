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

function rustRawString(functionName: string, returnType: string): string | null {
  const match = rustSource.match(
    new RegExp(
      `fn ${functionName}\\(\\) -> ${returnType} \\{\\s*r#"([\\s\\S]*?)"#`
    )
  )
  return match?.[1] ?? null
}

function rustPrompt(functionName: string): string {
  const direct = rustSource.match(
    new RegExp(
      `fn ${functionName}\\(\\) -> String \\{\\s*r#"([\\s\\S]*?)"#\\s*\\.to_string\\(\\)\\s*\\}`
    )
  )
  if (direct) return direct[1] ?? ''

  // Some defaults are the current text joined to a legacy raw string.
  const composed = rustSource.match(
    new RegExp(
      `fn ${functionName}\\(\\) -> String \\{\\s*format!\\(\\s*"\\{\\}\\\\n\\\\n\\{\\}",\\s*r#"([\\s\\S]*?)"#,\\s*([A-Za-z0-9_]+)\\(\\)\\s*\\)`
    )
  )
  const head = composed?.[1]
  const tail = composed?.[2]
    ? rustRawString(composed[2], "&'static str")
    : null
  expect(
    head != null && tail != null,
    `${functionName} should be a Rust raw-string default`
  ).toBe(true)
  return `${head}\n\n${tail}`
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
