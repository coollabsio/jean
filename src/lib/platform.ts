import { isNativeApp } from './environment'

export const isMacOS = navigator.platform.includes('Mac')
export const isWindows = navigator.platform.includes('Win')

/**
 * Pre-open a blank browser tab synchronously during a user gesture.
 * On mobile/web, calling window.open() after an async operation (e.g. WebSocket invoke)
 * gets blocked by popup blockers. Call this BEFORE the async work, then pass the
 * returned window to openExternal().
 * Returns null on native Tauri (uses system opener instead).
 */
export function preOpenWindow(): Window | null {
  return isNativeApp() ? null : window.open('', '_blank')
}

export async function openExternal(
  url: string,
  preOpenedWindow?: Window | null
): Promise<void> {
  if (preOpenedWindow) {
    preOpenedWindow.location.href = url
  } else if (isNativeApp()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank')
  }
}

/**
 * Returns the correct modifier key symbol based on platform and environment.
 * Mac native app uses ⌘, Mac web uses ⌃ (Ctrl works in browser, Cmd is intercepted).
 */
export const getModifierSymbol = (): string => {
  if (!isMacOS) return 'Ctrl'
  return isNativeApp() ? '⌘' : '⌃'
}

/**
 * Get the platform-specific file manager name.
 * Returns "Finder" on macOS, "Explorer" on Windows, "Files" on Linux.
 */
export function getFileManagerName(): string {
  if (isMacOS) return 'Finder'
  if (isWindows) return 'Explorer'
  return 'Files'
}
