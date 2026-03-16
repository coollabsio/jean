import { useState, useEffect } from 'react'
import { isNativeApp } from '@/lib/environment'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { logger } from '@/lib/logger'

/**
 * Dialog that appears when user tries to quit while sessions are running.
 * Only shown in production mode (dev mode allows immediate quit).
 *
 * Listens for the 'quit-confirmation-requested' custom event dispatched
 * by useMainWindowEventListeners when running sessions are detected.
 */
export function QuitConfirmationDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handleQuitRequest = () => {
      setOpen(true)
    }

    window.addEventListener('quit-confirmation-requested', handleQuitRequest)
    return () => {
      window.removeEventListener(
        'quit-confirmation-requested',
        handleQuitRequest
      )
    }
  }, [])

  const handleQuit = async () => {
    if (!isNativeApp()) return
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().destroy()
    } catch (error) {
      logger.error('Failed to destroy window', { error })
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sessions are still running</AlertDialogTitle>
          <AlertDialogDescription>
            One or more sessions are actively processing. Quitting now will
            interrupt them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleQuit}>
            Quit Anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
