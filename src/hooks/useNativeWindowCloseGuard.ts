import { useEffect } from 'react'
import { isNativeApp } from '@/lib/environment'
import { logger } from '@/lib/logger'

/**
 * Register a production-only close handler that always finishes quit via
 * `destroy()`. Must live at App root so it stays active during preloading
 * overlays (when MainWindow is unmounted) and while reconnecting to a server.
 *
 * Windows can silently ignore `close()` when an async `onCloseRequested`
 * handler is registered — preventDefault() synchronously, then destroy().
 */
export function useNativeWindowCloseGuard(): void {
  useEffect(() => {
    // Dev mode allows immediate quit without confirmation.
    if (import.meta.env.DEV) return
    if (!isNativeApp()) return

    let unlisten: (() => void) | null = null
    let cleaned = false

    const setup = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const { checkHasRunningSessions, destroyAppWindow } =
          await import('@/lib/window-close')

        if (cleaned) return

        const fn = await getCurrentWindow().onCloseRequested(async event => {
          // MUST be synchronous — preventDefault after await is unreliable.
          event.preventDefault()

          try {
            const hasRunning = await checkHasRunningSessions()
            if (hasRunning) {
              window.dispatchEvent(
                new CustomEvent('quit-confirmation-requested')
              )
              return
            }
            await destroyAppWindow()
          } catch (error) {
            logger.error('Failed to handle close request', { error })
            try {
              await destroyAppWindow()
            } catch (destroyError) {
              logger.error('Failed to destroy window after close error', {
                error: destroyError,
              })
            }
          }
        })

        if (cleaned) {
          fn()
          return
        }
        unlisten = fn
      } catch (error) {
        logger.error('Failed to setup close listener', { error })
      }
    }

    setup()

    return () => {
      cleaned = true
      unlisten?.()
    }
  }, [])
}
