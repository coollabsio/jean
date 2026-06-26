import { describe, expect, it } from 'vitest'
import { looksLikeFilePath } from './link-utils'

describe('looksLikeFilePath', () => {
  it('does not treat ordinary slash phrases as file paths', () => {
    expect(looksLikeFilePath('Read/analyze')).toBe(false)
  })

  it('accepts common absolute and project-relative paths', () => {
    expect(looksLikeFilePath('/home/niko/report.pdf')).toBe(true)
    expect(looksLikeFilePath('./src/main.ts')).toBe(true)
    expect(looksLikeFilePath('src/components/chat/ToolCallInline.tsx')).toBe(true)
    expect(looksLikeFilePath('docs/tasks.md')).toBe(true)
  })
})
