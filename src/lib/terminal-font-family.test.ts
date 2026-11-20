import { describe, expect, it } from 'vitest'
import { resolveCustomTerminalFont } from './terminal-font-family'

describe('resolveCustomTerminalFont', () => {
  it('keeps a quoted font family with a fallback', () => {
    expect(resolveCustomTerminalFont('"Fira Code Nerd Font", monospace')).toBe(
      '"Fira Code Nerd Font", monospace'
    )
  })

  it('trims surrounding whitespace', () => {
    expect(resolveCustomTerminalFont('  Cascadia Code  ')).toBe('Cascadia Code')
  })

  it('strips control characters', () => {
    expect(resolveCustomTerminalFont('Jet\u0000Brains\u001fMono')).toBe(
      'JetBrainsMono'
    )
  })

  it('falls back for empty values', () => {
    expect(resolveCustomTerminalFont(null)).toBeNull()
    expect(resolveCustomTerminalFont(undefined)).toBeNull()
    expect(resolveCustomTerminalFont('')).toBeNull()
    expect(resolveCustomTerminalFont('   ')).toBeNull()
  })
})
