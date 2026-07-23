/**
 * Reliable app-window quit helpers for the native shell.
 *
 * Windows (and some Linux setups) do not reliably finish a close when an async
 * `onCloseRequested` handler only "falls through". Call `preventDefault()`
 * synchronously, then `destroy()` once the quit is allowed.
 *
 * During loading / reconnect the backend may be unreachable. Never block quit
 * on a hung `has_running_sessions` call — fail open after a short timeout, and
 * skip the check entirely when neither native IPC nor another backend is
 * available.
 */

import { hasBackend, isNativeApp } from './environment'
import { invoke } from './transport'

export const SESSION_CHECK_TIMEOUT_MS = 1500

export async function destroyAppWindow(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().destroy()
}

/**
 * Returns whether any sessions are actively running.
 * Fail-open: false when the backend is unavailable or the check times out.
 */
export async function checkHasRunningSessions(
  timeoutMs: number = SESSION_CHECK_TIMEOUT_MS
): Promise<boolean> {
  if (!isNativeApp() && !hasBackend()) return false

  try {
    return await Promise.race([
      invoke<boolean>('has_running_sessions'),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ])
  } catch {
    return false
  }
}

/**
 * Attempt to quit the native app window.
 * Shows the quit confirmation dialog when production sessions are running;
 * otherwise destroys the window (bypasses async close quirks on Windows).
 */
export async function requestAppQuit(): Promise<void> {
  if (!isNativeApp()) return

  if (!import.meta.env.DEV) {
    const hasRunning = await checkHasRunningSessions()
    if (hasRunning) {
      window.dispatchEvent(new CustomEvent('quit-confirmation-requested'))
      return
    }
  }

  await destroyAppWindow()
}
