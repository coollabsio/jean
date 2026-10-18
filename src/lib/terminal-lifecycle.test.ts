import { describe, expect, it } from 'vitest'
import { shouldAutoCloseTerminal } from './terminal-lifecycle'

describe('shouldAutoCloseTerminal', () => {
  it('keeps a run-command terminal open after a clean exit', () => {
    expect(
      shouldAutoCloseTerminal({
        exitCode: 0,
        signal: null,
        isPanel: true,
        isRunTerminal: true,
      })
    ).toBe(false)
  })

  it('keeps a run-command terminal open after a failed exit', () => {
    expect(
      shouldAutoCloseTerminal({
        exitCode: 1,
        signal: null,
        isPanel: true,
        isRunTerminal: true,
      })
    ).toBe(false)
  })

  it('still closes a normal panel shell after a clean exit', () => {
    expect(
      shouldAutoCloseTerminal({
        exitCode: 0,
        signal: null,
        isPanel: true,
        isRunTerminal: false,
      })
    ).toBe(true)
  })
})
