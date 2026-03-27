import { useEffect, useState } from 'react'
import { isWindows } from '@/lib/platform'
import { isNativeApp } from '@/lib/environment'

/**
 * Hook to track whether the current window is maximized.
 * Useful for adjusting UI elements like border radius when maximized.
 *
 * Only relevant for native Tauri windows on Windows — returns false in web mode.
 */
export function useWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isWindows || !isNativeApp()) return

    let unlisten: (() => void) | null = null
    let cancelled = false

    // Dynamic import to avoid loading @tauri-apps/api/window in web mode
    // (module-level init accesses window.__TAURI_INTERNALS__.metadata which
    // doesn't exist outside the native Tauri shell)
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (cancelled) return

      const appWindow = getCurrentWindow()

      // Check initial state
      appWindow
        .isMaximized()
        .then(setIsMaximized)
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        .catch(() => {})

      // Listen for resize events to update maximized state
      appWindow
        .onResized(async () => {
          try {
            const maximized = await appWindow.isMaximized()
            setIsMaximized(maximized)
          } catch {
            // ignore
          }
        })
        .then(fn => {
          if (cancelled) {
            fn()
          } else {
            unlisten = fn
          }
        })
    })

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return isMaximized
}
