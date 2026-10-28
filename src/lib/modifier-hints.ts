/**
 * Sets `data-mod-held` on <html> while ⌘/Ctrl/Alt is held, so `[data-mod-hint]`
 * shortcut hints (see App.css) show only when the user reaches for a shortcut.
 */
export function installModifierHints(
  root: HTMLElement = document.documentElement
) {
  const sync = (event: KeyboardEvent) => {
    const held = event.metaKey || event.ctrlKey || event.altKey
    if (held) root.setAttribute('data-mod-held', '')
    else root.removeAttribute('data-mod-held')
  }
  const clear = () => root.removeAttribute('data-mod-held')

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
