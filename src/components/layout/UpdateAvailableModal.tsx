import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { useUIStore } from '@/store/ui-store'
import { isNativeApp } from '@/lib/environment'
import { fetchGitHubReleaseNotes } from '@/lib/app-update'

function handleUpdateLater() {
  const modalVersion = useUIStore.getState().updateModalVersion
  useUIStore.getState().setUpdateModalVersion(null)
  // Don't overwrite ready/installing state with a deferred badge
  const { updateReadyVersion, isUpdateInstalling } = useUIStore.getState()
  if (updateReadyVersion || isUpdateInstalling) return
  if (modalVersion) {
    useUIStore.getState().setPendingUpdateVersion(modalVersion)
  }
}

export function UpdateAvailableModal() {
  const version = useUIStore(state => state.updateModalVersion)
  const readyVersion = useUIStore(state => state.updateReadyVersion)
  const isInstalling = useUIStore(state => state.isUpdateInstalling)
  const manifestNotes = useUIStore(state => state.updateModalNotes)
  const { data: releaseNotes } = useQuery({
    queryKey: ['app-update-release-notes', version],
    queryFn: () => fetchGitHubReleaseNotes(version ?? ''),
    enabled: version !== null && !manifestNotes,
    staleTime: Infinity,
    retry: false,
  })
  const notes = manifestNotes ?? releaseNotes ?? null
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
        if (!open) handleUpdateLater()
      }}
    >
      <DialogContent className={notes ? 'sm:max-w-lg' : 'sm:max-w-md'}>
        <DialogHeader>
          <DialogTitle>
            {isReady ? 'Update Ready' : 'Update Available'}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {notes && (
          <div className="max-h-[min(50vh,24rem)] min-w-0 overflow-y-auto rounded-md border bg-muted/30 px-4 py-3">
            <Markdown compact className="text-sm">
              {notes}
            </Markdown>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleUpdateLater}>
            Later
          </Button>
          <Button onClick={handleUpdate} disabled={isInstalling && !isReady}>
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
