import { isNativeApp } from './environment'

function isInsecureWebContext(): boolean {
  // Browsers only treat HTTPS and loopback HTTP (localhost / 127.0.0.1 / ::1)
  // as secure contexts. Plain HTTP on a Tailscale IP/MagicDNS name is insecure,
  // so navigator.clipboard is unavailable or rejects.
  return typeof window !== 'undefined' && window.isSecureContext === false
}

/**
 * Copy text to clipboard with fallback for insecure contexts (HTTP).
 *
 * Fallback chain:
 * 1. Native app → Tauri clipboard plugin
 * 2. Insecure HTTP → sync document.execCommand('copy') first (preserves user gesture)
 * 3. Secure context → navigator.clipboard.writeText()
 * 4. Remaining fallback → execCommand
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (isNativeApp()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return
  }

  const insecure = isInsecureWebContext()

  // On plain HTTP (e.g. http://100.x.y.z Tailscale), prefer the sync fallback
  // immediately. Awaiting the Clipboard API first can burn user activation and
  // leave execCommand blocked as well.
  if (insecure && execCommandCopyFallback(text)) {
    return
  }

  if (!insecure && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Browser clipboard can be denied after async work or without permission.
      // Fall through to local fallbacks instead of reporting success with no copy.
    }
  }

  if (execCommandCopyFallback(text)) return

  if (insecure) {
    throw new Error(
      'Copy failed: browsers block the clipboard API on plain HTTP except localhost. Open Jean via HTTPS (Tailscale Serve or a reverse proxy), or use http://localhost on this machine.'
    )
  }
  throw new Error(
    'Copy failed: browser clipboard access is unavailable or permission was denied.'
  )
}

/**
 * Read text from the clipboard.
 *
 * Fallback chain:
 * 1. Native app → Tauri clipboard plugin
 * 2. Secure context → navigator.clipboard.readText()
 */
export async function readFromClipboard(): Promise<string> {
  if (isNativeApp()) {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
    const text = await readText()
    return typeof text === 'string' ? text : ''
  }

  const insecure = isInsecureWebContext()

  if (!insecure && navigator.clipboard?.readText) {
    try {
      const text = await navigator.clipboard.readText()
      return typeof text === 'string' ? text : ''
    } catch {
      // Permission denied — report the browser error below. A web client must
      // never fall back to the server machine's unrelated clipboard.
    }
  }

  if (insecure) {
    throw new Error(
      'Paste failed: browsers block clipboard read on plain HTTP except localhost. Open Jean via HTTPS (Tailscale Serve or a reverse proxy), or use http://localhost on this machine.'
    )
  }
  throw new Error(
    'Paste failed: browser clipboard access is unavailable or permission was denied.'
  )
}

/**
 * Normalize clipboard text for PTY paste (CRLF/CR → LF).
 */
export function normalizeClipboardForTerminal(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Copy rich content (HTML + plain text) to clipboard.
 * Falls back to plain text copy if ClipboardItem API is unavailable.
 */
export async function copyHtmlToClipboard(
  html: string,
  plainText: string,
  fallbackPlainText = plainText
): Promise<void> {
  // ClipboardItem / clipboard.write require a secure context.
  if (
    !isInsecureWebContext() &&
    typeof ClipboardItem !== 'undefined' &&
    navigator.clipboard?.write
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ])
      return
    } catch {
      // Fall through to plain text
    }
  }

  await copyToClipboard(fallbackPlainText)
}

function execCommandCopyFallback(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  // iOS / some mobile browsers only copy from editable, non-readonly fields
  // that are in the document and selectable.
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)

  const selection = document.getSelection()
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, text.length)

  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
    if (selection) {
      selection.removeAllRanges()
      if (previousRange) selection.addRange(previousRange)
    }
  }
}
