/**
 * Helpers for the mobile/web terminal extra-keys bar (Termius-style).
 * Maps sticky Ctrl/Alt + keypresses into PTY byte sequences.
 */

/** Convert a single character under sticky Ctrl into a control character. */
export function applyCtrlModifier(key: string): string | null {
  if (key.length !== 1) return null

  const code = key.charCodeAt(0)

  // a-z / A-Z → Ctrl+letter (0x01–0x1a)
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64)

  // Common punctuation control combos
  switch (key) {
    case '@':
    case ' ':
      return '\x00'
    case '[':
      return '\x1b'
    case '\\':
      return '\x1c'
    case ']':
      return '\x1d'
    case '^':
    case '6':
      return '\x1e'
    case '_':
    case '-':
    case '/':
      return '\x1f'
    case '?':
      return '\x7f'
    default:
      return null
  }
}

/** Prefix a character with ESC for sticky Alt (common terminal meta convention). */
export function applyAltModifier(key: string): string | null {
  if (key.length !== 1) return null
  return `\x1b${key}`
}

/**
 * Resolve sticky modifier + KeyboardEvent into data to send, or null if the
 * key should pass through (pure modifiers, unmapped keys).
 */
export function resolveStickyKeyData(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>,
  stickyCtrl: boolean,
  stickyAlt: boolean
): string | null {
  if (!stickyCtrl && !stickyAlt) return null

  const { key } = event
  if (
    key === 'Control' ||
    key === 'Alt' ||
    key === 'Meta' ||
    key === 'Shift' ||
    key === 'CapsLock'
  ) {
    return null
  }

  // If the OS/browser already applied a modifier, don't double-apply.
  if (event.ctrlKey || event.altKey || event.metaKey) return null

  if (stickyCtrl) {
    const ctrlData = applyCtrlModifier(key)
    if (ctrlData !== null) return ctrlData
  }

  if (stickyAlt) {
    return applyAltModifier(key)
  }

  return null
}

export type TerminalExtraKeyAction =
  | { type: 'data'; data: string; label: string }
  | { type: 'toggle'; modifier: 'ctrl' | 'alt'; label: string }
  | { type: 'clipboard'; action: 'copy' | 'paste'; label: string }

/** Keys shown in the Termius-style bottom bar. */
export const TERMINAL_EXTRA_KEYS: TerminalExtraKeyAction[] = [
  { type: 'clipboard', action: 'paste', label: 'paste' },
  { type: 'clipboard', action: 'copy', label: 'copy' },
  { type: 'data', data: '\x1b', label: 'esc' },
  { type: 'data', data: '\t', label: 'tab' },
  { type: 'toggle', modifier: 'ctrl', label: 'ctrl' },
  { type: 'toggle', modifier: 'alt', label: 'alt' },
  { type: 'data', data: '/', label: '/' },
  { type: 'data', data: '|', label: '|' },
  { type: 'data', data: '~', label: '~' },
  { type: 'data', data: '-', label: '-' },
  { type: 'data', data: '\x03', label: '^C' },
  { type: 'data', data: '\x1c', label: '^\\' },
  { type: 'data', data: '\x13', label: '^S' },
  { type: 'data', data: '\x1a', label: '^Z' },
]
