/**
 * Restore keyboard focus after the Jean window is re-activated (alt-tab, etc.).
 *
 * On some platforms (notably Windows WebView2), the OS focuses the window but
 * the webview does not re-attach keyboard focus until a mouse click. That makes
 * the chat prompt and global shortcuts (e.g. Ctrl/Cmd+L) appear broken.
 *
 * Strategy:
 * 1. Track the last focused element via focusin
 * 2. On window focus, re-assert focus on that element if still mounted
 * 3. Otherwise prefer the chat input (via custom event) when present
 * 4. Fall back to focusing <body> so capture-phase keybindings receive keys
 *
 * @see https://github.com/coollabsio/jean/issues/577
 */

const BODY_FOCUSABLE_TAB_INDEX = -1
const FOCUS_OWNING_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
const OVERLAY_FOCUSABLE_SELECTOR =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]'

/** Whether an open overlay should own focus (do not steal). */
export function hasFocusOwningOverlay(): boolean {
  return !!document.querySelector(FOCUS_OWNING_OVERLAY_SELECTOR)
}

/** True when the active element can meaningfully receive keyboard input. */
export function isMeaningfulFocusTarget(
  element: Element | null
): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (element === document.body || element === document.documentElement) {
    return false
  }
  return true
}

/**
 * Ensure document.body can receive programmatic focus (needed for shortcut
 * delivery when no input is focused).
 */
export function ensureBodyCanReceiveFocus(): void {
  // Without an explicit tabindex, body.focus() is a no-op in some webviews.
  if (!document.body.hasAttribute('tabindex')) {
    document.body.tabIndex = BODY_FOCUSABLE_TAB_INDEX
  }
}

/**
 * Re-attach keyboard focus after the window becomes active.
 *
 * @param lastFocused - Element that last held focus (from focusin tracking)
 * @returns which restore path was taken (for tests / diagnostics)
 */
export function restoreKeyboardFocusAfterWindowActivation(
  lastFocused: HTMLElement | null
): 'active' | 'last' | 'chat' | 'body' | 'overlay' {
  const active = document.activeElement

  if (hasFocusOwningOverlay()) {
    if (isMeaningfulFocusTarget(active)) {
      active.focus({ preventScroll: true })
    } else {
      document
        .querySelector(FOCUS_OWNING_OVERLAY_SELECTOR)
        ?.querySelector<HTMLElement>(OVERLAY_FOCUSABLE_SELECTOR)
        ?.focus({ preventScroll: true })
    }
    return 'overlay'
  }

  // Case 1: DOM still reports a real focus target (common after alt-tab).
  // Re-calling focus() re-attaches WebView keyboard input without moving caret.
  if (isMeaningfulFocusTarget(active)) {
    active.focus({ preventScroll: true })
    return 'active'
  }

  // Case 2: Restore the last focused element if it is still in the document.
  if (
    lastFocused &&
    document.contains(lastFocused) &&
    isMeaningfulFocusTarget(lastFocused)
  ) {
    lastFocused.focus({ preventScroll: true })
    if (isMeaningfulFocusTarget(document.activeElement)) {
      return 'last'
    }
  }

  // Case 3: Prefer chat prompt when ChatWindow is mounted.
  window.dispatchEvent(new CustomEvent('focus-chat-input'))
  if (isMeaningfulFocusTarget(document.activeElement)) {
    return 'chat'
  }

  // Case 4: Focus body so document-level keybindings receive keydown events.
  ensureBodyCanReceiveFocus()
  document.body.focus({ preventScroll: true })
  return 'body'
}

/**
 * Install listeners that restore keyboard focus when the window is re-activated.
 * Returns a cleanup function.
 */
export function installWindowKeyboardFocusRestore(): () => void {
  let lastFocused: HTMLElement | null = null
  let restoreFrame: number | null = null

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    // Never treat body/html as a restore target — they are focus sinks
    // used when the real control lost keyboard focus (alt-tab / blur).
    if (target === document.body || target === document.documentElement) return
    // Ignore ephemeral non-visible focus sinks
    if (target.closest?.('.sr-only')) return
    lastFocused = target
  }

  const onWindowFocus = () => {
    if (restoreFrame !== null) {
      cancelAnimationFrame(restoreFrame)
    }
    // Defer one frame so the browser finishes activation first.
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = null
      restoreKeyboardFocusAfterWindowActivation(lastFocused)
    })
  }

  // Seed from current focus if the app already has one.
  if (isMeaningfulFocusTarget(document.activeElement)) {
    lastFocused = document.activeElement
  }

  ensureBodyCanReceiveFocus()
  document.addEventListener('focusin', onFocusIn)
  window.addEventListener('focus', onWindowFocus)

  return () => {
    document.removeEventListener('focusin', onFocusIn)
    window.removeEventListener('focus', onWindowFocus)
    if (restoreFrame !== null) {
      cancelAnimationFrame(restoreFrame)
      restoreFrame = null
    }
  }
}
