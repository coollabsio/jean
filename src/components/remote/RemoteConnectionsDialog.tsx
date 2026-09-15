import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  HardDriveDownload,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Spinner } from '@/components/ui/spinner'
import { isNativeApp } from '@/lib/environment'
import { cn } from '@/lib/utils'
import {
  addRemoteConnection,
  parseOptionalSshPort,
  parseRemoteConnectionInput,
  removeRemoteConnection,
  setRemoteConnectionEnabled,
  setLocalDashboardEnabled,
  updateRemoteConnection,
  useRemoteConnections,
  useLocalDashboardEnabled,
  type RemoteConnection,
} from '@/lib/remote-connections'
import { DISMISS_TRANSIENT_UI_EVENT } from '@/lib/dismiss-transient-ui'
import {
  checkRemoteVersionCompatibility,
  fetchRemoteServerInfo,
  formatJeanVersionLabel,
  getLocalJeanVersion,
  warnRemoteVersionMismatch,
} from '@/lib/remote-version'
import { invoke, listenLocal } from '@/lib/transport'

const EMPTY_URL_FORM = {
  name: '',
  url: '',
  token: '',
  sshUser: '',
  sshHost: '',
  sshPort: '22',
}
const EMPTY_INSTALL_FORM = {
  name: '',
  user: '',
  host: '',
  sshPort: '22',
  jeanPort: '3456',
}

type AddMode = 'url' | 'install'
type EditorMode = null | 'new' | string

export interface InstallRemoteResult {
  name: string
  url: string
  token: string
  alreadyInstalled: boolean
  installMode: string
  ready: boolean
  log: string
}

type VersionState =
  | { status: 'loading' }
  | { status: 'ready'; version: string | null }
  | { status: 'error'; message: string }

interface RemoteConnectionsDialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
}

export function RemoteConnectionsDialog({
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: RemoteConnectionsDialogProps = {}) {
  const connections = useRemoteConnections()
  const localVersion = getLocalJeanVersion()
  const native = isNativeApp()
  const localDashboardEnabled = useLocalDashboardEnabled()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [controlledOpen, onOpenChange]
  )
  const [editingId, setEditingId] = useState<EditorMode>(null)
  const [addMode, setAddMode] = useState<AddMode>('url')
  const [form, setForm] = useState(EMPTY_URL_FORM)
  const [installForm, setInstallForm] = useState(EMPTY_INSTALL_FORM)
  const [error, setError] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [versions, setVersions] = useState<Record<string, VersionState>>({})
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)

  const connectionIds = connections.map(connection => connection.id).join('|')

  const refreshVersions = useCallback(async (items: RemoteConnection[]) => {
    if (items.length === 0) {
      setVersions(current => (Object.keys(current).length === 0 ? current : {}))
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
        setAddMode('url')
        setForm({
          name: connection.name,
          url: connection.url,
          token: connection.token,
          sshUser: connection.sshUser ?? '',
          sshHost: connection.sshHost ?? '',
          sshPort: String(connection.sshPort ?? 22),
        })
        setError(null)
        setProgress(null)
        setInstalling(false)
      }
    }
    window.addEventListener('open-remote-connections', handleOpen)
    return () =>
      window.removeEventListener('open-remote-connections', handleOpen)
  }, [connections])

  // Close when remote connection recovery dismisses transient UI (#623).
  useEffect(() => {
    const handleDismiss = () => {
      setOpen(false)
      setEditingId(null)
    }
    window.addEventListener(DISMISS_TRANSIENT_UI_EVENT, handleDismiss)
    return () =>
      window.removeEventListener(DISMISS_TRANSIENT_UI_EVENT, handleDismiss)
  }, [])

  useEffect(() => {
    if (!open || !installing || !native) return
    let disposed = false
    let unlisten: (() => void) | undefined

    void listenLocal<{ step: string; message: string }>(
      'remote-install:progress',
      event => {
        if (!disposed) setProgress(event.payload.message)
      }
    ).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [open, installing, native])

  const beginAdd = () => {
    setEditingId('new')
    setAddMode(native ? 'install' : 'url')
    setForm(EMPTY_URL_FORM)
    setInstallForm(EMPTY_INSTALL_FORM)
    setError(null)
    setProgress(null)
    setInstalling(false)
  }

  const beginEdit = (connection: RemoteConnection) => {
    setEditingId(connection.id)
    setAddMode('url')
    setForm({
      name: connection.name,
      url: connection.url,
      token: connection.token,
      sshUser: connection.sshUser ?? '',
      sshHost: connection.sshHost ?? '',
      sshPort: String(connection.sshPort ?? 22),
    })
    setError(null)
    setProgress(null)
    setInstalling(false)
  }

  const connectionInputFromUrlForm = () => {
    const sshPort = parseOptionalSshPort(form.sshPort)
    return {
      name: form.name,
      url: form.url,
      token: form.token,
      sshUser: form.sshUser.trim() || undefined,
      sshHost: form.sshHost.trim() || undefined,
      sshPort,
    }
  }

  const handleUrlSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setConnectingId(editingId === 'new' ? 'new' : editingId)

    try {
      const input = connectionInputFromUrlForm()
      // Normalize URL/token (incl. token-from-query) before probing.
      const normalized = parseRemoteConnectionInput(input.url, input.token)

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
        addRemoteConnection(input)
        setEditingId(null)
        return
      }
      if (editingId) {
        const updated = updateRemoteConnection(editingId, input)
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

  const handleInstallSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!native) {
      setError('Remote install is only available in the native Jean app.')
      return
    }

    const user = installForm.user.trim()
    const host = installForm.host.trim()
    if (!user || !host) {
      setError('SSH user and host/IP are required.')
      return
    }

    const sshPort = Number(installForm.sshPort || '22')
    const jeanPort = Number(installForm.jeanPort || '3456')
    if (
      !Number.isInteger(sshPort) ||
      sshPort < 1 ||
      sshPort > 65535 ||
      !Number.isInteger(jeanPort) ||
      jeanPort < 1 ||
      jeanPort > 65535
    ) {
      setError('SSH and Jean ports must be integers between 1 and 65535.')
      return
    }

    setError(null)
    setInstalling(true)
    setProgress('Starting remote install…')

    try {
      const result = await invoke<InstallRemoteResult>(
        'install_remote_jean_server',
        {
          name: installForm.name.trim() || null,
          user,
          host,
          sshPort,
          jeanPort,
          userInstall: null,
        }
      )

      if (!result.ready) {
        throw new Error('Remote jean-server did not report ready.')
      }

      addRemoteConnection({
        name: result.name,
        url: result.url,
        token: result.token,
        sshUser: user,
        sshHost: host,
        sshPort,
      })
      setEditingId(null)
      setInstalling(false)
      setProgress(null)
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : String(installError)
      )
      setInstalling(false)
      setProgress(null)
    }
  }

  const handleDelete = (id: string) => {
    removeRemoteConnection(id)
  }

  const isNew = editingId === 'new'
  const showInstallForm = isNew && addMode === 'install'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {showTrigger && (
        <DialogTrigger asChild>
          <Button
            aria-label="Connections"
            title="Connections"
            variant="ghost"
            size="icon"
            className="relative h-6 w-6 rounded-none text-foreground/70 hover:text-foreground"
          >
            <Server className="size-3.5" />
          </Button>
        </DialogTrigger>
      )}
      {/* Above RemoteConnectionRecovery (z-100) so Edit connection works while offline. */}
      <DialogContent className="sm:max-w-md z-[110]" overlayClassName="z-[110]">
        <DialogHeader>
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            Manage the Jean servers used by the combined dashboard.
          </DialogDescription>
        </DialogHeader>

        {editingId ? (
          showInstallForm ? (
            <form className="space-y-4" onSubmit={handleInstallSubmit}>
              {native && (
                <AddModeTabs
                  mode={addMode}
                  onChange={mode => {
                    if (installing) return
                    setAddMode(mode)
                    setError(null)
                  }}
                  disabled={installing}
                />
              )}
              <div className="space-y-1.5">
                <Label htmlFor="remote-install-name">Name</Label>
                <Input
                  id="remote-install-name"
                  value={installForm.name}
                  onChange={event =>
                    setInstallForm(current => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="Build server"
                  disabled={installing}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="remote-install-user">SSH user</Label>
                  <Input
                    id="remote-install-user"
                    value={installForm.user}
                    onChange={event =>
                      setInstallForm(current => ({
                        ...current,
                        user: event.target.value,
                      }))
                    }
                    placeholder="ubuntu"
                    required
                    disabled={installing}
                    autoComplete="username"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="remote-install-host">Host / IP</Label>
                  <Input
                    id="remote-install-host"
                    value={installForm.host}
                    onChange={event =>
                      setInstallForm(current => ({
                        ...current,
                        host: event.target.value,
                      }))
                    }
                    placeholder="192.168.1.50"
                    required
                    disabled={installing}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="remote-install-ssh-port">SSH port</Label>
                  <Input
                    id="remote-install-ssh-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={installForm.sshPort}
                    onChange={event =>
                      setInstallForm(current => ({
                        ...current,
                        sshPort: event.target.value,
                      }))
                    }
                    disabled={installing}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="remote-install-jean-port">Jean port</Label>
                  <Input
                    id="remote-install-jean-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={installForm.jeanPort}
                    onChange={event =>
                      setInstallForm(current => ({
                        ...current,
                        jeanPort: event.target.value,
                      }))
                    }
                    disabled={installing}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Requires SSH key auth to the host (no password prompt). Jean
                installs via the official installer, checks health/ready/auth,
                then adds the connection when everything is green.
              </p>
              {progress && (
                <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <Spinner className="mt-0.5 size-3.5 shrink-0" />
                  <span>{progress}</span>
                </div>
              )}
              {error && (
                <p className="whitespace-pre-wrap text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingId(null)}
                  disabled={installing}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={installing}>
                  {installing ? (
                    <>
                      <Spinner className="mr-2 size-4" />
                      Installing…
                    </>
                  ) : (
                    <>
                      <HardDriveDownload className="mr-2 size-4" />
                      Install & Connect
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={handleUrlSubmit}>
              {isNew && native && (
                <AddModeTabs
                  mode={addMode}
                  onChange={mode => {
                    setAddMode(mode)
                    setError(null)
                  }}
                  disabled={connectingId !== null}
                />
              )}
              <div className="space-y-1.5">
                <Label htmlFor="remote-name">Name</Label>
                <Input
                  id="remote-name"
                  value={form.name}
                  onChange={event =>
                    setForm(current => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="Build server"
                  disabled={connectingId !== null}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="remote-url">Web Access URL</Label>
                <Input
                  id="remote-url"
                  value={form.url}
                  onChange={event =>
                    setForm(current => ({
                      ...current,
                      url: event.target.value,
                    }))
                  }
                  placeholder="https://jean.example.com/?token=..."
                  required
                  disabled={connectingId !== null}
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
                  disabled={connectingId !== null}
                />
              </div>
              <div className="space-y-2 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">SSH for editor (Zed)</p>
                  <p className="text-xs text-muted-foreground">
                    Used when Open in Editor runs against this remote. Defaults
                    host to the Web Access hostname when left blank.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="remote-ssh-user">SSH user</Label>
                    <Input
                      id="remote-ssh-user"
                      value={form.sshUser}
                      onChange={event =>
                        setForm(current => ({
                          ...current,
                          sshUser: event.target.value,
                        }))
                      }
                      placeholder="ubuntu"
                      autoComplete="username"
                      disabled={connectingId !== null}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="remote-ssh-host">SSH host</Label>
                    <Input
                      id="remote-ssh-host"
                      value={form.sshHost}
                      onChange={event =>
                        setForm(current => ({
                          ...current,
                          sshHost: event.target.value,
                        }))
                      }
                      placeholder="Same as Web Access host"
                      disabled={connectingId !== null}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="remote-ssh-port">SSH port</Label>
                  <Input
                    id="remote-ssh-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.sshPort}
                    onChange={event =>
                      setForm(current => ({
                        ...current,
                        sshPort: event.target.value,
                      }))
                    }
                    disabled={connectingId !== null}
                  />
                </div>
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
                  {isNew ? 'Save & Connect' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          )
        ) : (
          <div className="space-y-2">
            <ConnectionRow
              name="Local"
              detail="This computer"
              versionLabel={formatJeanVersionLabel(localVersion)}
              enabled={native ? localDashboardEnabled : undefined}
              onEnabledChange={native ? setLocalDashboardEnabled : undefined}
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
                  onEdit={() => beginEdit(connection)}
                  onDelete={() => handleDelete(connection.id)}
                  enabled={native ? connection.enabled : undefined}
                  onEnabledChange={
                    native
                      ? enabled =>
                          setRemoteConnectionEnabled(connection.id, enabled)
                      : undefined
                  }
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

const ADD_MODE_TABS: {
  id: AddMode
  label: string
  icon: typeof HardDriveDownload
}[] = [
  { id: 'install', label: 'Install via SSH', icon: HardDriveDownload },
  { id: 'url', label: 'Existing URL', icon: Link2 },
]

function AddModeTabs({
  mode,
  onChange,
  disabled = false,
}: {
  mode: AddMode
  onChange: (mode: AddMode) => void
  disabled?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label="Add connection method"
      className="flex border-b border-border"
    >
      {ADD_MODE_TABS.map(tab => {
        const selected = mode === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors',
              'border-b-2 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-50',
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground'
            )}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

function ConnectionRow({
  name,
  detail,
  versionLabel,
  versionWarning,
  onEdit,
  onDelete,
  enabled,
  onEnabledChange,
}: {
  name: string
  detail: string
  versionLabel: string
  versionWarning?: boolean
  onEdit?: () => void
  onDelete?: () => void
  enabled?: boolean
  onEnabledChange?: (enabled: boolean) => void
}) {
  const hasActions = Boolean(onEdit || onDelete)

  return (
    <div className="rounded-md border p-2">
      {/* Top row: name + version always share full width so versions align */}
      <div className="flex w-full items-center gap-2 text-left text-sm font-medium">
        <span className="size-2 shrink-0 rounded-full bg-green-500" />
        {name}
        <span
          className={`ml-auto shrink-0 text-xs font-normal ${
            versionWarning
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground'
          }`}
          title={
            versionWarning ? 'Remote version differs from this app' : undefined
          }
        >
          {versionLabel}
          {versionWarning ? ' · mismatch' : ''}
        </span>
      </div>
      {/* Second row: detail URL + edit/delete actions */}
      <div className="ml-4 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">
          {detail}
        </span>
        {hasActions && (
          <div className="flex shrink-0 items-center gap-0.5">
            {onEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Edit ${name}`}
                onClick={onEdit}
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
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
      {onEnabledChange && (
        <label className="ml-4 mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={enabled}
            onCheckedChange={checked => onEnabledChange(checked === true)}
            aria-label={`Include ${name} in combined dashboard`}
          />
          Include in combined dashboard
        </label>
      )}
    </div>
  )
}
