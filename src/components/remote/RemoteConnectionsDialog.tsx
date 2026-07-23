import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  Check,
  HardDriveDownload,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from 'lucide-react'
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
import { Spinner } from '@/components/ui/spinner'
import { isNativeApp } from '@/lib/environment'
import { cn } from '@/lib/utils'
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

export function RemoteConnectionsDialog({
  reloadApp = () => window.location.reload(),
}: {
  reloadApp?: () => void
}) {
  const connections = useRemoteConnections()
  const activeId = getActiveConnectionId()
  const remoteActive = activeId !== LOCAL_CONNECTION_ID
  const localVersion = getLocalJeanVersion()
  const native = isNativeApp()
  const [open, setOpen] = useState(false)
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

  const parseOptionalSshPort = (raw: string): number | undefined => {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    const port = Number(trimmed)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be an integer between 1 and 65535.')
    }
    return port
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
        const connection = addRemoteConnection(input)
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
          updateRemoteConnection(editingId, input)
          markConnectionSwitch()
          reloadApp()
          return
        }
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

      const connection = addRemoteConnection({
        name: result.name,
        url: result.url,
        token: result.token,
        sshUser: user,
        sshHost: host,
        sshPort,
      })
      markConnectionSwitch()
      selectConnection(connection.id)
      reloadApp()
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
    const wasActive = id === activeId
    removeRemoteConnection(id)
    if (wasActive) {
      markConnectionSwitch()
      reloadApp()
    }
  }

  const isNew = editingId === 'new'
  const showInstallForm = isNew && addMode === 'install'

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
            server. Install jean-server on a Linux host with SSH user + IP, or
            paste an existing Web Access URL. This app is{' '}
            {formatJeanVersionLabel(localVersion)}; a warning is shown when a
            remote reports a different version.
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
