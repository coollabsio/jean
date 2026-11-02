/**
 * Sets `data-mod-held` on <html> while ⌘/Ctrl/Alt is held, so `[data-mod-hint]`
 * shortcut hints (see App.css) show only when the user reaches for a shortcut.
 * Sets `data-primary-mod-held` while ⌘/Ctrl is held (the Mod+Enter actions).
 */
export function installModifierHints(
  root: HTMLElement = document.documentElement
) {
  const sync = (event: KeyboardEvent) => {
    const primary = event.metaKey || event.ctrlKey
    root.toggleAttribute('data-mod-held', primary || event.altKey)
    root.toggleAttribute('data-primary-mod-held', primary)
  }
  const clear = () => {
    root.removeAttribute('data-mod-held')
    root.removeAttribute('data-primary-mod-held')
  }

  window.addEventListener('keydown', sync, true)
  window.addEventListener('keyup', sync, true)
  window.addEventListener('blur', clear)
  return () => {
    window.removeEventListener('keydown', sync, true)
    window.removeEventListener('keyup', sync, true)
    window.removeEventListener('blur', clear)
    clear()
  }
}
