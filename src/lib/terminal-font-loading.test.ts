import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureTerminalFontLoaded } from './terminal-font-loading'

describe('ensureTerminalFontLoaded', () => {
  const originalFontsDescriptor = Object.getOwnPropertyDescriptor(
    document,
    'fonts'
  )

  afterEach(() => {
    if (originalFontsDescriptor) {
      Object.defineProperty(document, 'fonts', originalFontsDescriptor)
    } else {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('waits for the regular and bold terminal fonts', async () => {
    const load = vi.fn().mockResolvedValue([])
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load },
    })

    await ensureTerminalFontLoaded('"JetBrains Mono", monospace', 13)

    expect(load).toHaveBeenNthCalledWith(
      1,
      '400 13px "JetBrains Mono", monospace',
      'Jean terminal font probe ➜ ✗'
    )
    expect(load).toHaveBeenNthCalledWith(
      2,
      '500 13px "JetBrains Mono", monospace',
      'Jean terminal font probe ➜ ✗'
    )
  })

  it('does not resolve before the fonts finish loading', async () => {
    let finishLoading: (() => void) | undefined
    const loading = new Promise<void>(resolve => {
      finishLoading = resolve
    })
    const load = vi.fn().mockReturnValue(loading)
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load },
    })

    let resolved = false
    const result = ensureTerminalFontLoaded(
      '"JetBrains Mono", monospace',
      13
    ).then(() => {
      resolved = true
    })
    await Promise.resolve()

    expect(resolved).toBe(false)

    finishLoading?.()
    await result
    expect(resolved).toBe(true)
  })

  it('does not block the terminal when a font fails to load', async () => {
    const load = vi.fn().mockRejectedValue(new Error('font unavailable'))
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load },
    })

    await expect(
      ensureTerminalFontLoaded('"JetBrains Mono", monospace', 13)
    ).resolves.toBeUndefined()
  })
})
