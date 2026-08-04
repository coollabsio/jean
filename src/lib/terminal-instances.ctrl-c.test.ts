import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

/**
 * Regression guards for issue #635: remote terminal Ctrl-C must not be
 * silently dropped, and failed writes of interrupt bytes must be retried.
 */
describe('terminal Ctrl-C remote desync regression (issue #635)', () => {
  const source = readSource('src/lib/terminal-instances.ts')

  it('holds critical control chars while the transport is disconnected', () => {
    expect(source).toContain('pendingCriticalInput')
    expect(source).toContain('extractCriticalControlChars')
    expect(source).toContain("CRITICAL_TERMINAL_CONTROL_CHARS")
    // Offline path must not early-return without preserving Ctrl-C.
    expect(source).toMatch(
      /if \(!isTransportConnected\(\)\) \{[\s\S]*?extractCriticalControlChars/
    )
  })

  it('retries critical control chars when terminal_write fails', () => {
    expect(source).toContain('terminal_write failed')
    expect(source).toMatch(
      /sendTerminalWrite[\s\S]*?extractCriticalControlChars\(data\)/
    )
  })

  it('flushes sticky interrupts on wake/reconnect paths', () => {
    const wakeStart = source.indexOf('const wake = () => {')
    expect(wakeStart).toBeGreaterThan(-1)
    const wakeEnd = source.indexOf('document.addEventListener', wakeStart)
    const wakeBody = source.slice(wakeStart, wakeEnd)
    expect(wakeBody).toContain('flushPendingCriticalInput()')
  })
})
