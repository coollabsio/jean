import { openUrl } from '@tauri-apps/plugin-opener'
import { isNativeApp } from './environment'

export type PlatformName = 'mac' | 'windows' | 'linux'

let serverPlatform: PlatformName = 'linux'

// Window chrome belongs to the local client, even when commands target a
// remote Jean server running on a different operating system.
const clientPlatform =
  typeof navigator === 'undefined'
    ? ''
    : (navigator.platform || navigator.userAgent).toLowerCase()

export const isClientMacOS = clientPlatform.includes('mac')
export const isClientLinux = clientPlatform.includes('linux')

export let isMacOS = false
export let isWindows = false
export let isLinux = true

export function setServerPlatform(platform: PlatformName): void {
  serverPlatform = platform
  isMacOS = platform === 'mac'
  isWindows = platform === 'windows'
  isLinux = platform === 'linux'
}

export function getServerPlatform(): PlatformName {
  return serverPlatform
}

export function isServerWindows(): boolean {
  return serverPlatform === 'windows'
}

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
  if (isNativeApp()) {
    // Do not pass `inAppBrowser`: Tauri opener defaults to the OS/browser app on
    // mobile, while `inAppBrowser` is the embedded-browser behavior we avoid.
    await openUrl(url)
    return
  }

  if (preOpenedWindow) {
    preOpenedWindow.location.href = url
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Returns the correct modifier key symbol based on platform and environment.
 * Mac native app uses ⌘, Mac web uses ⌃ (Ctrl works in browser, Cmd is intercepted).
 */
export const getModifierSymbol = (): string => {
  if (!isClientMacOS) return 'Ctrl'
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

/**
 * Strip WSL UNC prefix from a path for display purposes.
 * `\\wsl.localhost\Ubuntu\home\user\project` -> `/home/user/project`
 * `\\wsl$\Ubuntu\home\user` -> `/home/user`
 * Non-WSL paths are returned as-is.
 */
export function getDisplayPath(path: string, wslEnabled?: boolean): string {
  if (!wslEnabled) return path

  // Normalize backslashes for matching
  const normalized = path.replace(/\\/g, '/')

  // Match \\wsl.localhost\<distro>\... or \\wsl$\<distro>\...
  for (const prefix of ['//wsl.localhost/', '//wsl$/']) {
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length)
      const slashPos = rest.indexOf('/')
      if (slashPos >= 0) {
        return rest.slice(slashPos)
      }
      return '/'
    }
  }

  return path
}
