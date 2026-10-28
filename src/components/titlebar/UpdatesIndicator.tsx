import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { LoaderCircle, X } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { CLI_DISPLAY_NAMES, resolveCliPathUpdateAction } from '@/lib/cli-update'
import { updateTargetLabel } from '@/lib/environment'
import { applyServerUpdate } from '@/hooks/useServerUpdateCheck'
import {
  useUIStore,
  type MinimizedCliUpdate,
  type PendingCliUpdate,
  type PendingServerUpdate,
} from '@/store/ui-store'

/** One row in the updates popover. */
interface PendingUpdate {
  id: string
  title: string
  detail: string
  /** Work is in progress: spinner instead of the dot. */
  busy: boolean
  /** Same action the old title bar pill ran; absent while nothing can be done. */
  run?: () => void
  dismiss?: () => void
}

function appUpdate(
  pendingVersion: string | null,
  readyVersion: string | null,
  isInstalling: boolean
): PendingUpdate | null {
  // Ready wins; deferred and mid-download updates stay listed so the user
  // keeps an affordance after dismissing the update modal.
  const version = readyVersion ?? pendingVersion
  if (!version && !isInstalling) return null
  const downloading = isInstalling && !readyVersion
  const detail = readyVersion
    ? `Restart to apply v${readyVersion}`
    : downloading
      ? version
        ? `Downloading v${version}…`
        : 'Downloading update…'
      : `Update to v${version}`
  return {
    id: 'app',
    title: 'Jean',
    detail: `${detail} · ${updateTargetLabel()}`,
    busy: downloading,
    run: downloading
      ? undefined
      : () => window.dispatchEvent(new Event('install-pending-update')),
  }
}

function serverUpdate(pending: PendingServerUpdate): PendingUpdate {
  return {
    id: 'server',
    title: 'jean-server',
    detail: pending.canUpdate
      ? `${updateTargetLabel()} · v${pending.currentVersion} → v${pending.latestVersion}`
      : `${updateTargetLabel()} · v${pending.latestVersion} (manual update)`,
    busy: false,
    run: () => {
      if (pending.canUpdate) {
        void applyServerUpdate(pending.latestVersion)
        return
      }
      toast.info(
        `jean-server ${pending.latestVersion} is available (${updateTargetLabel()})`,
        {
          id: 'server-update-available',
          description:
            pending.reason ||
            'This host cannot self-update. Replace the binary or image manually.',
          duration: 12_000,
        }
      )
    },
  }
}

function minimizedCliUpdate(update: MinimizedCliUpdate): PendingUpdate {
  const status =
    update.kind === 'reinstall' && update.progress !== null
      ? `${Math.round(update.progress)}%`
      : 'Updating…'
  return {
    id: 'cli-minimized',
    title: update.name,
    detail: `${update.target} · ${status}`,
    busy: true,
    run: () => useUIStore.getState().restoreMinimizedCliUpdate(),
  }
}

function runCliUpdate(update: PendingCliUpdate) {
  const ui = useUIStore.getState()
  if (update.cliSource === 'path') {
    const action = resolveCliPathUpdateAction(
      update.type,
      update.cliPath,
      update.packageManager,
      update.latestVersion
    )
    if (!action) {
      toast.error(
        `Can't auto-update ${CLI_DISPLAY_NAMES[update.type]} (${updateTargetLabel()}). Update it manually via your package manager.`
      )
      return
    }
    ui.openCliLoginModal(update.type, action[0], action[1], 'update')
  } else {
    ui.openCliUpdateModal(update.type)
  }
  ui.dismissCliUpdateNotice(update.type)
}

function cliUpdate(update: PendingCliUpdate): PendingUpdate {
  return {
    id: `cli-${update.type}`,
    title: CLI_DISPLAY_NAMES[update.type],
    detail: `${updateTargetLabel()} · v${update.currentVersion} → v${update.latestVersion}`,
    busy: false,
    run: () => runCliUpdate(update),
    dismiss: () => useUIStore.getState().dismissCliUpdateNotice(update.type),
  }
}

function usePendingUpdates(): PendingUpdate[] {
  const pendingVersion = useUIStore(state => state.pendingUpdateVersion)
  const readyVersion = useUIStore(state => state.updateReadyVersion)
  const isInstalling = useUIStore(state => state.isUpdateInstalling)
  const server = useUIStore(state => state.pendingServerUpdate)
  const minimized = useUIStore(state => state.minimizedCliUpdate)
  const clis = useUIStore(state => state.availableCliUpdates)

  const app = appUpdate(pendingVersion, readyVersion, isInstalling)
  return [
    ...(app ? [app] : []),
    ...(server ? [serverUpdate(server)] : []),
    ...(minimized ? [minimizedCliUpdate(minimized)] : []),
    ...clis.map(cliUpdate),
  ]
}

/** Single title bar entry for app, jean-server and CLI updates. */
export function UpdatesIndicator() {
  const updates = usePendingUpdates()
  const [open, setOpen] = useState(false)
  const empty = updates.length === 0

  // Do not reopen by itself when a later update shows up
  useEffect(() => {
    if (empty) setOpen(false)
  }, [empty])

  if (empty) return null

  const busy = updates.some(update => update.busy)
  const label = updates.length === 1 ? 'Update' : `${updates.length} updates`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="mr-1 h-6 gap-1.5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          aria-label={`${label} available`}
          data-testid="updates-indicator"
        >
          {busy ? (
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
          ) : (
            <span
              className="size-1.5 rounded-full bg-muted-foreground"
              aria-hidden
            />
          )}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        {updates.map(update => (
          <div key={update.id} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!update.run}
              onClick={() => {
                setOpen(false)
                update.run?.()
              }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
            >
              {update.busy && (
                <LoaderCircle
                  className="size-3 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden
                />
              )}
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">
                  {update.title}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {update.detail}
                </span>
              </span>
            </button>
            {update.dismiss && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={update.dismiss}
                aria-label={`Dismiss ${update.title} update`}
                className="text-muted-foreground"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
