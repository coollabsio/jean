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
import { isNativeApp } from '@/lib/environment'

export function UpdateAvailableModal() {
  const version = useUIStore(state => state.updateModalVersion)
  const readyVersion = useUIStore(state => state.updateReadyVersion)
  const isInstalling = useUIStore(state => state.isUpdateInstalling)
  const isOpen = version !== null
  const native = isNativeApp()

  const handleUpdate = () => {
    const targetVersion = version
    useUIStore.getState().setUpdateModalVersion(null)
    // Keep sticky version so web/host apply can read it if the native
    // pendingUpdateRef is empty. If already installed, install-pending-update
    // relaunches instead of re-downloading (#507).
    if (targetVersion) {
      useUIStore.getState().setPendingUpdateVersion(targetVersion)
    }
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

  const description = isReady
    ? `Version ${version} is installed. Restart to apply it.`
    : native
      ? `Version ${version} is ready to install.`
      : `Version ${version} is ready on the host Jean app. Updating will download and install there, then restart the host.`

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
          <DialogDescription>{description}</DialogDescription>
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
