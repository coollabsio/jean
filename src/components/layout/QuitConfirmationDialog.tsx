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

async function handleQuitAnyway() {
  if (!isNativeApp()) return
  try {
    const { destroyAppWindow } = await import('@/lib/window-close')
    await destroyAppWindow()
  } catch (error) {
    logger.error('Failed to destroy window', { error })
  }
}

/**
 * Dialog that appears when user tries to quit while sessions are running.
 * Only shown in production mode (dev mode allows immediate quit).
 *
 * Listens for the 'quit-confirmation-requested' custom event dispatched
 * by useNativeWindowCloseGuard / window-close when running sessions are detected.
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
          <AlertDialogAction onClick={handleQuitAnyway}>
            Quit Anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
