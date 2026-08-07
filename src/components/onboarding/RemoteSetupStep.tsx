/**
 * Onboarding remote setup: install jean-server over SSH or connect an existing
 * Web Access URL. On success, selects the connection and reloads so CLI setup
 * (if needed) continues against the remote.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { HardDriveDownload, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { isNativeApp } from '@/lib/environment'
import { cn } from '@/lib/utils'
import {
  addRemoteConnection,
  markConnectionSwitch,
  parseOptionalSshPort,
  parseRemoteConnectionInput,
  selectConnection,
} from '@/lib/remote-connections'
import {
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
} from '@/lib/remote-version'
import { invoke, listenLocal } from '@/lib/transport'
import type { InstallRemoteResult } from '@/components/remote/RemoteConnectionsDialog'

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

interface RemoteSetupStepProps {
  reloadApp?: () => void
}

export function RemoteSetupStep({
  reloadApp = () => window.location.reload(),
}: RemoteSetupStepProps) {
  const native = isNativeApp()
  const [addMode, setAddMode] = useState<AddMode>(native ? 'install' : 'url')
  const [form, setForm] = useState(EMPTY_URL_FORM)
  const [installForm, setInstallForm] = useState(EMPTY_INSTALL_FORM)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)

  useEffect(() => {
    if (!installing || !native) return
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
  }, [installing, native])

  const handleUrlSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setConnecting(true)

    try {
      const sshPort = parseOptionalSshPort(form.sshPort)
      const input = {
        name: form.name,
        url: form.url,
        token: form.token,
        sshUser: form.sshUser.trim() || undefined,
        sshHost: form.sshHost.trim() || undefined,
        sshPort,
      }
      const normalized = parseRemoteConnectionInput(input.url, input.token)

      try {
        const info = await fetchRemoteServerInfo(
          normalized.url,
          normalized.token
        )
        warnRemoteVersionMismatch(info.appVersion)
      } catch (probeError) {
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
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : String(submitError)
      )
    } finally {
      setConnecting(false)
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

  const busy = connecting || installing

  if (addMode === 'install' && native) {
    return (
      <form className="space-y-4" onSubmit={handleInstallSubmit}>
        <AddModeTabs
          mode={addMode}
          onChange={mode => {
            if (busy) return
            setAddMode(mode)
            setError(null)
          }}
          disabled={busy}
        />
        <div className="space-y-1.5">
          <Label htmlFor="onboarding-remote-install-name">Name</Label>
          <Input
            id="onboarding-remote-install-name"
            value={installForm.name}
            onChange={event =>
              setInstallForm(current => ({
                ...current,
                name: event.target.value,
              }))
            }
            placeholder="Build server"
            disabled={busy}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-remote-install-user">SSH user</Label>
            <Input
              id="onboarding-remote-install-user"
              value={installForm.user}
              onChange={event =>
                setInstallForm(current => ({
                  ...current,
                  user: event.target.value,
                }))
              }
              placeholder="ubuntu"
              required
              disabled={busy}
              autoComplete="username"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-remote-install-host">Host / IP</Label>
            <Input
              id="onboarding-remote-install-host"
              value={installForm.host}
              onChange={event =>
                setInstallForm(current => ({
                  ...current,
                  host: event.target.value,
                }))
              }
              placeholder="192.168.1.50"
              required
              disabled={busy}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-remote-install-ssh-port">SSH port</Label>
            <Input
              id="onboarding-remote-install-ssh-port"
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
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-remote-install-jean-port">
              Jean port
            </Label>
            <Input
              id="onboarding-remote-install-jean-port"
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
              disabled={busy}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Requires SSH key auth to the host (no password prompt). Jean installs
          via the official installer, checks health, then connects. After
          connecting, AI CLI setup continues on the remote if needed.
        </p>
        {progress && (
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <Spinner className="mt-0.5 size-3.5 shrink-0" />
            <span>{progress}</span>
          </div>
        )}
        {error && (
          <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p>
        )}
        <Button type="submit" className="w-full" size="lg" disabled={busy}>
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
      </form>
    )
  }

  return (
    <form className="space-y-4" onSubmit={handleUrlSubmit}>
      {native && (
        <AddModeTabs
          mode={addMode}
          onChange={mode => {
            if (busy) return
            setAddMode(mode)
            setError(null)
          }}
          disabled={busy}
        />
      )}
      <div className="space-y-1.5">
        <Label htmlFor="onboarding-remote-name">Name</Label>
        <Input
          id="onboarding-remote-name"
          value={form.name}
          onChange={event =>
            setForm(current => ({
              ...current,
              name: event.target.value,
            }))
          }
          placeholder="Build server"
          disabled={busy}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="onboarding-remote-url">Web Access URL</Label>
        <Input
          id="onboarding-remote-url"
          value={form.url}
          onChange={event =>
            setForm(current => ({
              ...current,
              url: event.target.value,
            }))
          }
          placeholder="https://jean.example.com/?token=..."
          required
          disabled={busy}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="onboarding-remote-token">Access token</Label>
        <Input
          id="onboarding-remote-token"
          type="password"
          value={form.token}
          onChange={event =>
            setForm(current => ({
              ...current,
              token: event.target.value,
            }))
          }
          placeholder="Optional when included in the URL"
          disabled={busy}
        />
      </div>
      <div className="space-y-2 rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">SSH for editor (Zed)</p>
          <p className="text-xs text-muted-foreground">
            Used when Open in Editor runs against this remote. Defaults host to
            the Web Access hostname when left blank.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-remote-ssh-user">SSH user</Label>
            <Input
              id="onboarding-remote-ssh-user"
              value={form.sshUser}
              onChange={event =>
                setForm(current => ({
                  ...current,
                  sshUser: event.target.value,
                }))
              }
              placeholder="ubuntu"
              autoComplete="username"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-remote-ssh-host">SSH host</Label>
            <Input
              id="onboarding-remote-ssh-host"
              value={form.sshHost}
              onChange={event =>
                setForm(current => ({
                  ...current,
                  sshHost: event.target.value,
                }))
              }
              placeholder="Same as Web Access host"
              disabled={busy}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="onboarding-remote-ssh-port">SSH port</Label>
          <Input
            id="onboarding-remote-ssh-port"
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
            disabled={busy}
          />
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {connecting && <Loader2 className="mr-2 size-4 animate-spin" />}
        Save & Connect
      </Button>
    </form>
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
