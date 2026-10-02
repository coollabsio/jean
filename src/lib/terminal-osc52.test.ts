import { beforeEach, describe, expect, it, vi } from 'vitest'

const copyToClipboardMock = vi.fn()
const toastErrorMock = vi.fn()

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: copyToClipboardMock,
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock },
}))

const { parseOsc52Payload, registerOsc52ClipboardHandler } = await import(
  './terminal-osc52'
)

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe('parseOsc52Payload', () => {
  it('decodes ASCII payloads', () => {
    expect(parseOsc52Payload('c;aGVsbG8=')).toBe('hello')
  })

  it('decodes UTF-8 payloads', () => {
    expect(parseOsc52Payload(`c;${base64('café 🚀')}`)).toBe('café 🚀')
  })

  it('accepts an empty target list', () => {
    expect(parseOsc52Payload(';aGk=')).toBe('hi')
  })

  it('ignores clipboard read requests', () => {
    expect(parseOsc52Payload('c;?')).toBeNull()
  })

  it('ignores empty payloads', () => {
    expect(parseOsc52Payload('c;')).toBeNull()
  })

  it('ignores data without a separator', () => {
    expect(parseOsc52Payload('aGVsbG8=')).toBeNull()
  })

  it('ignores invalid base64', () => {
    expect(parseOsc52Payload('c;not base64!')).toBeNull()
  })

  it('ignores oversized payloads', () => {
    expect(parseOsc52Payload(`c;${'A'.repeat(1024 * 1024 + 4)}`)).toBeNull()
  })
})

describe('registerOsc52ClipboardHandler', () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset()
    toastErrorMock.mockReset()
  })

  function setup() {
    const registerOscHandler = vi.fn()
    registerOsc52ClipboardHandler({
      parser: { registerOscHandler },
    } as never)
    expect(registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function))
    return registerOscHandler.mock.calls[0]?.[1] as (data: string) => boolean
  }

  it('copies decoded text and consumes the sequence', () => {
    copyToClipboardMock.mockResolvedValue(undefined)
    const handler = setup()

    expect(handler('c;aGVsbG8=')).toBe(true)
    expect(copyToClipboardMock).toHaveBeenCalledWith('hello')
  })

  it('does not touch the clipboard for read requests', () => {
    const handler = setup()

    expect(handler('c;?')).toBe(true)
    expect(copyToClipboardMock).not.toHaveBeenCalled()
  })

  it('shows an error toast when the copy fails', async () => {
    copyToClipboardMock.mockRejectedValue(new Error('Copy failed: denied'))
    const handler = setup()

    handler('c;aGVsbG8=')
    await vi.waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Copy failed: denied')
    )
  })
})
