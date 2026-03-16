import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isWindows } from '@/lib/platform'

/**
 * Hook to track whether the current window is maximized.
 * Useful for adjusting UI elements like border radius when maximized.
 */
export function useWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isWindows) return

    const appWindow = getCurrentWindow()

    // Check initial state
    appWindow
      .isMaximized()
      .then(setIsMaximized)
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      .catch(() => {})

    // Listen for resize events to update maximized state
    let unlisten: (() => void) | null = null
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
        unlisten = fn
      })

    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  return isMaximized
}
