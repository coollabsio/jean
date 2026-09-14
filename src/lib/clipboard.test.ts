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

  it('does not write to the server clipboard when the browser clipboard is unavailable', async () => {
    await expect(copyToClipboard('debug details')).rejects.toThrow(
      /browser.*clipboard|permission/i
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not write to the server clipboard when browser clipboard permission is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new DOMException('denied')),
      },
    })

    await expect(copyToClipboard('debug details')).rejects.toThrow(
      /permission/i
    )
    expect(invokeMock).not.toHaveBeenCalled()
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

    await expect(copyToClipboard('nope')).rejects.toThrow(/HTTPS|localhost/i)
    expect(invokeMock).not.toHaveBeenCalled()
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

  it('does not read the server clipboard when browser clipboard access is unavailable', async () => {
    await expect(readFromClipboard()).rejects.toThrow(
      /browser.*clipboard|permission/i
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('explains HTTPS requirement when insecure paste fully fails', async () => {
    setSecureContext(false)

    await expect(readFromClipboard()).rejects.toThrow(/HTTPS|localhost/i)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('normalizeClipboardForTerminal', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeClipboardForTerminal('a\r\nb\rc')).toBe('a\nb\nc')
  })
})
