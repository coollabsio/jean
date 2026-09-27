import type { IDisposable, Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'

/** Ignore absurdly large OSC 52 payloads (base64 characters). */
const MAX_OSC52_PAYLOAD_LENGTH = 1024 * 1024

/**
 * Decode an OSC 52 payload (`<targets>;<base64>`, the text after `52;`).
 * Returns null for clipboard read requests (`?`), empty or invalid payloads.
 */
export function parseOsc52Payload(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator === -1) return null

  const payload = data.slice(separator + 1)
  if (
    !payload ||
    payload === '?' ||
    payload.length > MAX_OSC52_PAYLOAD_LENGTH
  ) {
    return null
  }

  try {
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Copy OSC 52 clipboard writes (used by Claude CLI, tmux, vim, ...) to the
 * user's clipboard. Read requests are ignored so programs in the PTY can
 * never read the clipboard.
 */
export function registerOsc52ClipboardHandler(
  terminal: Pick<Terminal, 'parser'>
): IDisposable {
  return terminal.parser.registerOscHandler(52, data => {
    const text = parseOsc52Payload(data)
    if (text) {
      copyToClipboard(text).catch(error => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    }
    return true
  })
}
