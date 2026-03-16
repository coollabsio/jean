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
  const isOpen = version !== null

  const handleUpdate = () => {
    useUIStore.getState().setUpdateModalVersion(null)
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
            Version {version} is ready to install.
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
