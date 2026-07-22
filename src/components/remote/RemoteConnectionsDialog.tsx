import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Check, Loader2, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  LOCAL_CONNECTION_ID,
  addRemoteConnection,
  getActiveConnectionId,
  markConnectionSwitch,
  parseRemoteConnectionInput,
  removeRemoteConnection,
  selectConnection,
  updateRemoteConnection,
  useRemoteConnections,
  type RemoteConnection,
} from '@/lib/remote-connections'
import {
  checkRemoteVersionCompatibility,
  fetchRemoteServerInfo,
  formatJeanVersionLabel,
  getLocalJeanVersion,
  warnRemoteVersionMismatch,
} from '@/lib/remote-version'

const EMPTY_FORM = { name: '', url: '', token: '' }

type VersionState =
  | { status: 'loading' }
  | { status: 'ready'; version: string | null }
  | { status: 'error'; message: string }

export function RemoteConnectionsDialog({
  reloadApp = () => window.location.reload(),
}: {
  reloadApp?: () => void
}) {
  const connections = useRemoteConnections()
  const activeId = getActiveConnectionId()
  const remoteActive = activeId !== LOCAL_CONNECTION_ID
  const localVersion = getLocalJeanVersion()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [versions, setVersions] = useState<Record<string, VersionState>>({})

  const connectionIds = connections.map(connection => connection.id).join('|')

  const refreshVersions = useCallback(async (items: RemoteConnection[]) => {
    if (items.length === 0) {
      setVersions(current =>
        Object.keys(current).length === 0 ? current : {}
      )
      return
    }

    setVersions(current => {
      const next: Record<string, VersionState> = {}
      let changed = false
      for (const connection of items) {
        const existing = current[connection.id]
        next[connection.id] = existing ?? { status: 'loading' }
        if (!existing || existing.status !== next[connection.id]?.status) {
          changed = true
        }
      }
      for (const id of Object.keys(current)) {
        if (!(id in next)) changed = true
      }
      return changed ? next : current
    })

    const results = await Promise.all(
      items.map(async connection => {
        try {
          const info = await fetchRemoteServerInfo(
            connection.url,
            connection.token
          )
          return [
            connection.id,
            {
              status: 'ready' as const,
              version: info.appVersion,
            },
          ] as const
        } catch (probeError) {
          return [
            connection.id,
            {
              status: 'error' as const,
              message:
                probeError instanceof Error
                  ? probeError.message
                  : String(probeError),
            },
          ] as const
        }
      })
    )

    setVersions(Object.fromEntries(results))
  }, [])

  useEffect(() => {
    if (!open || editingId) return
    void refreshVersions(connections)
    // connectionIds captures membership changes without depending on array identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId, connectionIds, refreshVersions])

  useEffect(() => {
    const handleOpen = (event: Event) => {
      setOpen(true)
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      const connection = connections.find(item => item.id === id)
      if (connection) {
        setEditingId(connection.id)
        setForm({
          name: connection.name,
          url: connection.url,
          token: connection.token,
        })
        setError(null)
      }
    }
    window.addEventListener('open-remote-connections', handleOpen)
    return () =>
      window.removeEventListener('open-remote-connections', handleOpen)
  }, [connections])

  const beginAdd = () => {
    setEditingId('new')
    setForm(EMPTY_FORM)
    setError(null)
  }

  const beginEdit = (connection: RemoteConnection) => {
    setEditingId(connection.id)
    setForm({
      name: connection.name,
      url: connection.url,
      token: connection.token,
    })
    setError(null)
  }

  const switchTo = async (id: string) => {
    if (id === activeId || connectingId) return

    if (id === LOCAL_CONNECTION_ID) {
      markConnectionSwitch()
      selectConnection(id)
      reloadApp()
      return
    }

    const connection = connections.find(item => item.id === id)
    if (!connection) return

    setConnectingId(id)
    setError(null)
    try {
      // Best-effort probe so the user sees a version toast before reload;
      // transport re-checks after connect. Failures do not block switching.
      const info = await fetchRemoteServerInfo(
        connection.url,
        connection.token
      )
      warnRemoteVersionMismatch(info.appVersion)
    } catch {
      // Unreachable remotes still switch so recovery UI can handle them.
    }

    markConnectionSwitch()
    selectConnection(id)
    reloadApp()
    setConnectingId(null)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setConnectingId(editingId === 'new' ? 'new' : editingId)

    try {
      // Normalize URL/token (incl. token-from-query) before probing.
      const normalized = parseRemoteConnectionInput(form.url, form.token)

      if (editingId === 'new') {
        try {
          const info = await fetchRemoteServerInfo(
            normalized.url,
            normalized.token
          )
          warnRemoteVersionMismatch(info.appVersion)
        } catch (probeError) {
          // Still allow save/connect; transport/recovery handles auth/network.
          // Surface probe failures only when we cannot normalize further.
          if (
            probeError instanceof Error &&
            probeError.message.includes('Invalid access token')
          ) {
            setError(probeError.message)
            return
          }
        }
        const connection = addRemoteConnection(form)
        markConnectionSwitch()
        selectConnection(connection.id)
        reloadApp()
        return
      }
      if (editingId) {
        if (editingId === activeId) {
          try {
            const info = await fetchRemoteServerInfo(
              normalized.url,
              normalized.token
            )
            warnRemoteVersionMismatch(info.appVersion)
          } catch {
            // Allow reconnect; recovery screen handles hard failures.
          }
          updateRemoteConnection(editingId, form)
          markConnectionSwitch()
          reloadApp()
          return
        }
        const updated = updateRemoteConnection(editingId, form)
        // Probe after save so the list shows the new version promptly.
        void refreshVersions(
          connections.map(item => (item.id === editingId ? updated : item))
        )
        setEditingId(null)
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : String(submitError)
      )
    } finally {
      setConnectingId(null)
    }
  }

  const handleDelete = (id: string) => {
    const wasActive = id === activeId
    removeRemoteConnection(id)
    if (wasActive) {
      markConnectionSwitch()
      reloadApp()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          aria-label="Jean connections"
          title="Jean connections"
          variant="ghost"
          size="icon"
          className="relative h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
        >
          <Server className="size-3.5" />
          {remoteActive && (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-green-500" />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Jean connections</DialogTitle>
          <DialogDescription>
            Switch this client between Local and a remote Jean Web Access
            server. This app is {formatJeanVersionLabel(localVersion)}; a
            warning is shown when a remote reports a different version.
          </DialogDescription>
        </DialogHeader>

        {editingId ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="remote-name">Name</Label>
              <Input
                id="remote-name"
                value={form.name}
                onChange={event =>
                  setForm(current => ({ ...current, name: event.target.value }))
                }
                placeholder="Build server"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="remote-url">Web Access URL</Label>
              <Input
                id="remote-url"
                value={form.url}
                onChange={event =>
                  setForm(current => ({ ...current, url: event.target.value }))
                }
                placeholder="https://jean.example.com/?token=..."
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="remote-token">Access token</Label>
              <Input
                id="remote-token"
                type="password"
                value={form.token}
                onChange={event =>
                  setForm(current => ({
                    ...current,
                    token: event.target.value,
                  }))
                }
                placeholder="Optional when included in the URL"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditingId(null)
                  setError(null)
                }}
                disabled={connectingId !== null}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={connectingId !== null}>
                {connectingId !== null && (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                )}
                {editingId === 'new' ? 'Save & Connect' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-2">
            <ConnectionRow
              name="Local"
              detail="This computer"
              versionLabel={formatJeanVersionLabel(localVersion)}
              active={activeId === LOCAL_CONNECTION_ID}
              connecting={connectingId === LOCAL_CONNECTION_ID}
              onSelect={() => void switchTo(LOCAL_CONNECTION_ID)}
            />
            {connections.map(connection => {
              const versionState = versions[connection.id]
              const mismatch =
                versionState?.status === 'ready' &&
                !checkRemoteVersionCompatibility(versionState.version)
                  .compatible
              const versionLabel =
                versionState?.status === 'ready'
                  ? formatJeanVersionLabel(versionState.version)
                  : versionState?.status === 'error'
                    ? 'unreachable'
                    : 'checking…'
              return (
                <ConnectionRow
                  key={connection.id}
                  name={connection.name}
                  detail={connection.url}
                  versionLabel={versionLabel}
                  versionWarning={mismatch}
                  active={activeId === connection.id}
                  connecting={connectingId === connection.id}
                  onSelect={() => void switchTo(connection.id)}
                  onEdit={() => beginEdit(connection)}
                  onDelete={() => handleDelete(connection.id)}
                />
              )
            })}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="button"
              variant="outline"
              className="mt-2 w-full"
              onClick={beginAdd}
            >
              <Plus className="mr-2 size-4" />
              Add remote
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConnectionRow({
  name,
  detail,
  versionLabel,
  versionWarning,
  active,
  connecting,
  onSelect,
  onEdit,
  onDelete,
}: {
  name: string
  detail: string
  versionLabel: string
  versionWarning?: boolean
  active: boolean
  connecting?: boolean
  onSelect: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border p-2">
      <button
        type="button"
        className="min-w-0 flex-1 text-left disabled:opacity-60"
        onClick={onSelect}
        disabled={connecting}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            className={`size-2 rounded-full ${active ? 'bg-green-500' : 'bg-muted-foreground/35'}`}
          />
          {name}
          {active && <Check className="size-3.5 text-green-500" />}
          {connecting && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}
          <span
            className={`ml-auto shrink-0 text-xs font-normal ${
              versionWarning
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
            }`}
            title={
              versionWarning
                ? 'Remote version differs from this app'
                : undefined
            }
          >
            {versionLabel}
            {versionWarning ? ' · mismatch' : ''}
          </span>
        </span>
        <span className="ml-4 block truncate text-xs text-muted-foreground">
          {detail}
        </span>
      </button>
      {onEdit && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Edit ${name}`}
          onClick={onEdit}
          disabled={connecting}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      {onDelete && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-destructive"
          aria-label={`Delete ${name}`}
          onClick={onDelete}
          disabled={connecting}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
