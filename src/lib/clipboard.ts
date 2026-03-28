import { isNativeApp } from './environment'

/**
 * Copy text to clipboard with fallback for insecure contexts (HTTP).
 *
 * Fallback chain:
 * 1. Native app → Tauri clipboard plugin
 * 2. Secure context → navigator.clipboard.writeText()
 * 3. Insecure context → document.execCommand('copy') with hidden textarea
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (isNativeApp()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  // Fallback for insecure contexts (HTTP web access)
  execCommandCopyFallback(text)
}

/**
 * Copy rich content (HTML + plain text) to clipboard.
 * Falls back to plain text copy if ClipboardItem API is unavailable.
 */
export async function copyHtmlToClipboard(
  html: string,
  plainText: string
): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ])
    return
  }

  // Fall back to plain text
  await copyToClipboard(plainText)
}

function execCommandCopyFallback(text: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}
