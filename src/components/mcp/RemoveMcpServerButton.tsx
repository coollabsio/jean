import { useState } from 'react'
import { toast } from 'sonner'
import { Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
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
import { getBackendLabel } from '@/components/ui/backend-label'
import { invokeForOptionalServer } from '@/lib/transport'
import { invalidateAllMcpServers } from '@/services/mcp'
import type { CliBackend } from '@/types/preferences'

export function RemoveMcpServerButton({
  backend,
  serverName,
  serverId,
  onRemoved,
}: {
  backend: CliBackend
  serverName: string
  serverId: string
  onRemoved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    const toastId = toast.loading(`Removing ${serverName}...`)
    try {
      const path = await invokeForOptionalServer<string>(
        serverId,
        'remove_mcp_server',
        { backend, name: serverName }
      )
      invalidateAllMcpServers()
      onRemoved()
      toast.success(`Removed ${serverName} from ${path}`, { id: toastId })
      setOpen(false)
    } catch (error) {
      toast.error(String(error), { id: toastId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${serverName}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <AlertDialog open={open} onOpenChange={next => !busy && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {serverName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Jean removes this server from your user-level{' '}
              {getBackendLabel(backend)} config and keeps a backup of the old
              file. Running sessions keep the server until they restart.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void remove()
              }}
            >
              {busy ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
