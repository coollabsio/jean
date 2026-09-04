import { describe, expect, it, vi } from 'vitest'
import { formatPathForPty } from './useTerminalFileDrop'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/environment', () => ({ isLocalBackend: () => true }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../attachment-processing', () => ({
  saveAttachmentFileToDisk: vi.fn(),
}))

describe('formatPathForPty', () => {
  it('writes plain paths unquoted so Claude Code detects them', () => {
    expect(formatPathForPty('/tmp/docs/report.pdf')).toBe(
      '/tmp/docs/report.pdf '
    )
  })

  it('quotes whitespace', () => {
    expect(formatPathForPty('/Users/me/Application Support/a.pdf')).toBe(
      "'/Users/me/Application Support/a.pdf' "
    )
  })

  it('quotes shell metacharacters in user filenames', () => {
    // Dropped paths are user-controlled: unquoted, this would run `id`.
    expect(formatPathForPty('/tmp/$(id).pdf')).toBe("'/tmp/$(id).pdf' ")
    expect(formatPathForPty('/tmp/a;b.pdf')).toBe("'/tmp/a;b.pdf' ")
    expect(formatPathForPty('/tmp/report(v2).pdf')).toBe(
      "'/tmp/report(v2).pdf' "
    )
    expect(formatPathForPty('/tmp/notes&more.txt')).toBe(
      "'/tmp/notes&more.txt' "
    )
  })

  it('escapes embedded single quotes', () => {
    expect(formatPathForPty("/tmp/it's.pdf")).toBe("'/tmp/it'\\''s.pdf' ")
  })
})
