import { ArrowUpCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

export function UpdateAvailableModal() {
  const version = useUIStore(state => state.updateModalVersion)
  const readyVersion = useUIStore(state => state.updateReadyVersion)
  const isInstalling = useUIStore(state => state.isUpdateInstalling)
  const isOpen = version !== null

  const handleUpdate = () => {
    useUIStore.getState().setUpdateModalVersion(null)
    // If already installed, install-pending-update relaunches instead of re-downloading (#507)
    window.dispatchEvent(new Event('install-pending-update'))
  }

  const handleLater = () => {
    const modalVersion = useUIStore.getState().updateModalVersion
    useUIStore.getState().setUpdateModalVersion(null)
    // Don't overwrite ready/installing state with a deferred badge
    const { updateReadyVersion, isUpdateInstalling } = useUIStore.getState()
    if (updateReadyVersion || isUpdateInstalling) return
    if (modalVersion) {
      useUIStore.getState().setPendingUpdateVersion(modalVersion)
    }
  }

  const isReady = readyVersion !== null && readyVersion === version
  const primaryLabel = isReady
    ? 'Restart Now'
    : isInstalling
      ? 'Downloading…'
      : 'Update Now'

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) handleLater()
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="size-5 text-primary" />
            {isReady ? 'Update Ready' : 'Update Available'}
          </DialogTitle>
          <DialogDescription>
            {isReady
              ? `Version ${version} is installed. Restart to apply it.`
              : `Version ${version} is ready to install.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handleLater}>
            Later
          </Button>
          <Button onClick={handleUpdate} disabled={isInstalling && !isReady}>
            {primaryLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
