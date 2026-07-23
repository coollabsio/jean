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
  const isOpen = version !== null
  const native = isNativeApp()

  const handleUpdate = () => {
    const targetVersion = version
    useUIStore.getState().setUpdateModalVersion(null)
    // Keep sticky version so web/host apply can read it if the native
    // pendingUpdateRef is empty.
    if (targetVersion) {
      useUIStore.getState().setPendingUpdateVersion(targetVersion)
    }
    window.dispatchEvent(new Event('install-pending-update'))
  }

  const handleLater = () => {
    useUIStore.getState().setUpdateModalVersion(null)
    useUIStore.getState().setPendingUpdateVersion(version)
  }

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
            Update Available
          </DialogTitle>
          <DialogDescription>
            {native
              ? `Version ${version} is ready to install.`
              : `Version ${version} is ready on the host Jean app. Updating will download and install there, then restart the host.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handleLater}>
            Later
          </Button>
          <Button onClick={handleUpdate}>Update Now</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
