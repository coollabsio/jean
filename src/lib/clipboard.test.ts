import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()

vi.mock('./environment', () => ({
  isNativeApp: () => false,
}))

vi.mock('./transport', () => ({
  invoke: invokeMock,
}))

const {
  copyToClipboard,
  copyHtmlToClipboard,
  normalizeClipboardForTerminal,
  readFromClipboard,
} = await import('./clipboard')

function setSecureContext(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: secure,
  })
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(null)
    setSecureContext(true)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    document.execCommand = vi.fn().mockReturnValue(false)
  })

  it('falls back to backend clipboard when browser clipboard is unavailable', async () => {
    await copyToClipboard('debug details')

    expect(invokeMock).toHaveBeenCalledWith('write_clipboard_text', {
      text: 'debug details',
    })
  })

  it('falls back to backend clipboard when browser clipboard write is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new DOMException('denied')),
      },
    })

    await copyToClipboard('debug details')

    expect(invokeMock).toHaveBeenCalledWith('write_clipboard_text', {
      text: 'debug details',
    })
  })

  it('uses sync execCommand first on insecure HTTP contexts', async () => {
    setSecureContext(false)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    document.execCommand = vi.fn().mockReturnValue(true)

    await copyToClipboard('tailscale copy')

    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(writeText).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('explains HTTPS requirement when insecure copy fully fails', async () => {
    setSecureContext(false)
    invokeMock.mockRejectedValue(new Error('Native clipboard access is only available in the desktop app'))

    await expect(copyToClipboard('nope')).rejects.toThrow(/HTTPS|localhost/i)
  })
})

describe('copyHtmlToClipboard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(null)
    setSecureContext(true)
    document.execCommand = vi.fn().mockReturnValue(true)
  })

  it('falls back to plain text on insecure contexts', async () => {
    setSecureContext(false)
    // ClipboardItem may exist in jsdom; force the insecure path.
    const write = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText: vi.fn() },
    })

    await copyHtmlToClipboard('<b>hi</b>', 'hi')

    expect(write).not.toHaveBeenCalled()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })
})

describe('readFromClipboard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue('')
    setSecureContext(true)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
  })

  it('uses navigator.clipboard.readText on secure contexts', async () => {
    const readText = vi.fn().mockResolvedValue('pasted text')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText },
    })

    await expect(readFromClipboard()).resolves.toBe('pasted text')
    expect(readText).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('falls back to backend clipboard when browser read is unavailable', async () => {
    invokeMock.mockResolvedValue('host paste')

    await expect(readFromClipboard()).resolves.toBe('host paste')
    expect(invokeMock).toHaveBeenCalledWith('read_clipboard_text')
  })

  it('explains HTTPS requirement when insecure paste fully fails', async () => {
    setSecureContext(false)
    invokeMock.mockRejectedValue(
      new Error('Native clipboard access is only available in the desktop app')
    )

    await expect(readFromClipboard()).rejects.toThrow(/HTTPS|localhost/i)
  })
})

describe('normalizeClipboardForTerminal', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeClipboardForTerminal('a\r\nb\rc')).toBe('a\nb\nc')
  })
})
