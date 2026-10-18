/**
 * Onboarding remote setup: install jean-server over SSH or connect an existing
 * Web Access URL. On success, the remote joins the native client's parallel
 * connection set and onboarding continues with backend setup on the remote.
 */

import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronRight,
  HardDriveDownload,
  Link2,
  Loader2,
  Plug,
  X,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { isNativeApp } from '@/lib/environment'
import { cn } from '@/lib/utils'
import {
  addRemoteConnection,
  parseOptionalSshPort,
  parseRemoteConnectionInput,
} from '@/lib/remote-connections'
import {
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
} from '@/lib/remote-version'
import { invoke, listenLocal } from '@/lib/transport'
import type { InstallRemoteResult } from '@/components/remote/RemoteConnectionsDialog'
import { InlineError, errorSummary } from './InlineError'

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

/** Concrete host alias from the local `~/.ssh/config`. */
interface SshConfigHost {
  alias: string
  hostName: string | null
  user: string | null
  port: number | null
}

/** Show chips up to this count; use a dropdown above it. */
const MAX_HOST_CHIPS = 6

const INSTALL_PHASES = [
  { id: 'ssh', label: 'Connect over SSH' },
  { id: 'probe', label: 'Check existing install' },
  { id: 'install', label: 'Install jean-server' },
  { id: 'health', label: 'Health check' },
  { id: 'done', label: 'Connected' },
] as const

type PhaseId = (typeof INSTALL_PHASES)[number]['id']

interface InstallProgress {
  step: PhaseId
  message: string
  /** Steps the backend reported. Steps it passed without a report were skipped. */
  reached: PhaseId[]
  failed: boolean
}

type RetryAction = 'install' | 'test' | 'url'

interface StepError {
  message: string
  details?: string
  /** Resolved at render time so Retry uses the current form values. */
  retry?: RetryAction
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; system: string }
  | { status: 'error'; error: StepError }

function isPhaseId(step: string): step is PhaseId {
  return INSTALL_PHASES.some(phase => phase.id === step)
}

function toStepError(error: unknown, retry?: RetryAction): StepError {
  const text = error instanceof Error ? error.message : String(error)
  return { message: errorSummary(error), details: text, retry }
}

interface RemoteSetupStepProps {
  /** Called with the new connection's server id. */
  onComplete: (serverId: string) => void
}

export function RemoteSetupStep({ onComplete }: RemoteSetupStepProps) {
  const native = isNativeApp()
  const [addMode, setAddMode] = useState<AddMode>(native ? 'install' : 'url')
  const [form, setForm] = useState(EMPTY_URL_FORM)
  const [installForm, setInstallForm] = useState(EMPTY_INSTALL_FORM)
  const [error, setError] = useState<StepError | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [testState, setTestState] = useState<TestState>({ status: 'idle' })

  const { data: sshHosts = [] } = useQuery({
    queryKey: ['ssh-config-hosts'],
    queryFn: () => invoke<SshConfigHost[]>('list_ssh_config_hosts'),
    enabled: native,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!installing || !native) return
    let disposed = false
    let unlisten: (() => void) | undefined

    void listenLocal<{ step: string; message: string }>(
      'remote-install:progress',
      event => {
        if (disposed) return
        const { step, message } = event.payload
        if (!isPhaseId(step)) return
        setProgress(current => ({
          step,
          message,
          reached: current?.reached.includes(step)
            ? current.reached
            : [...(current?.reached ?? []), step],
          failed: false,
        }))
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

  const handleUrlSubmit = async (event?: FormEvent) => {
    event?.preventDefault()
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
          setError(toStepError(probeError, 'url'))
          return
        }
      }

      onComplete(addRemoteConnection(input).id)
    } catch (submitError) {
      setError(toStepError(submitError, 'url'))
    } finally {
      setConnecting(false)
    }
  }

  /** Validate the SSH fields. Returns null and sets an error when invalid. */
  const readSshTarget = (
    onInvalid: (message: string) => void
  ): { user: string; host: string; sshPort: number } | null => {
    const user = installForm.user.trim()
    const host = installForm.host.trim()
    if (!user || !host) {
      onInvalid('SSH user and host/IP are required.')
      return null
    }
    const sshPort = Number(installForm.sshPort || '22')
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      onInvalid('SSH port must be an integer between 1 and 65535.')
      return null
    }
    return { user, host, sshPort }
  }

  const handleTestSsh = async () => {
    if (!native) return
    const target = readSshTarget(message =>
      setTestState({ status: 'error', error: { message } })
    )
    if (!target) return

    setTestState({ status: 'testing' })
    try {
      const system = await invoke<string>('test_ssh_connection', target)
      setTestState({ status: 'ok', system: system.trim() })
    } catch (testError) {
      setTestState({
        status: 'error',
        error: toStepError(testError, 'test'),
      })
    }
  }

  const handleInstallSubmit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!native) {
      setError({
        message: 'Remote install is only available in the native Jean app.',
      })
      return
    }

    const target = readSshTarget(message => setError({ message }))
    if (!target) return
    const { user, host, sshPort } = target

    const jeanPort = Number(installForm.jeanPort || '3456')
    if (!Number.isInteger(jeanPort) || jeanPort < 1 || jeanPort > 65535) {
      setError({ message: 'Jean port must be an integer between 1 and 65535.' })
      return
    }

    setError(null)
    setInstalling(true)
    setProgress({
      step: 'ssh',
      message: 'Starting remote install…',
      reached: ['ssh'],
      failed: false,
    })

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
      onComplete(connection.id)
    } catch (installError) {
      setError(toStepError(installError, 'install'))
      setInstalling(false)
      setProgress(current => current && { ...current, failed: true })
    }
  }

  const pickSshHost = (picked: SshConfigHost) => {
    setTestState({ status: 'idle' })
    setInstallForm(current => {
      const nameIsAuto =
        !current.name.trim() ||
        sshHosts.some(host => host.alias === current.name)
      return {
        ...current,
        host: picked.alias,
        user: picked.user ?? current.user,
        sshPort: String(picked.port ?? 22),
        name: nameIsAuto ? picked.alias : current.name,
      }
    })
  }

  const busy = connecting || installing
  const tabs = native && (
    <AddModeTabs
      mode={addMode}
      onChange={mode => {
        if (busy) return
        setAddMode(mode)
        setError(null)
      }}
      disabled={busy}
    />
  )
  const retryHandlers: Record<RetryAction, () => void> = {
    install: () => void handleInstallSubmit(),
    test: () => void handleTestSsh(),
    url: () => void handleUrlSubmit(),
  }
  const renderError = (stepError: StepError) => (
    <InlineError
      message={stepError.message}
      details={stepError.details}
      onRetry={
        busy || !stepError.retry ? undefined : retryHandlers[stepError.retry]
      }
    />
  )
  const errorMessage = error && renderError(error)

  if (addMode === 'install' && native) {
    const setField =
      (key: keyof typeof EMPTY_INSTALL_FORM) =>
      (event: ChangeEvent<HTMLInputElement>) => {
        if (key !== 'name' && key !== 'jeanPort') {
          setTestState({ status: 'idle' })
        }
        setInstallForm(current => ({ ...current, [key]: event.target.value }))
      }
    const testing = testState.status === 'testing'

    return (
      <form className="space-y-4" onSubmit={handleInstallSubmit}>
        {tabs}
        {sshHosts.length > 0 && (
          <SshHostPicker
            hosts={sshHosts}
            selected={installForm.host}
            onPick={pickSshHost}
            disabled={busy}
          />
        )}
        <div className="grid grid-cols-[2fr_3fr] gap-3">
          <Field id="onboarding-remote-install-user" label="SSH user">
            <Input
              id="onboarding-remote-install-user"
              value={installForm.user}
              onChange={setField('user')}
              placeholder="ubuntu"
              required
              disabled={busy}
              autoComplete="username"
            />
          </Field>
          <Field id="onboarding-remote-install-host" label="Host / IP">
            <Input
              id="onboarding-remote-install-host"
              value={installForm.host}
              onChange={setField('host')}
              placeholder="192.168.1.50"
              required
              disabled={busy}
            />
          </Field>
        </div>
        <AdvancedOptions>
          <Field id="onboarding-remote-install-name" label="Name">
            <Input
              id="onboarding-remote-install-name"
              value={installForm.name}
              onChange={setField('name')}
              placeholder="Build server"
              disabled={busy}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="onboarding-remote-install-ssh-port" label="SSH port">
              <Input
                id="onboarding-remote-install-ssh-port"
                type="number"
                min={1}
                max={65535}
                value={installForm.sshPort}
                onChange={setField('sshPort')}
                disabled={busy}
              />
            </Field>
            <Field id="onboarding-remote-install-jean-port" label="Jean port">
              <Input
                id="onboarding-remote-install-jean-port"
                type="number"
                min={1}
                max={65535}
                value={installForm.jeanPort}
                onChange={setField('jeanPort')}
                disabled={busy}
              />
            </Field>
          </div>
        </AdvancedOptions>
        {progress ? (
          <InstallPhases progress={progress} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Needs SSH key access (no password).
          </p>
        )}
        {testState.status === 'ok' && (
          <p className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
            <Check className="size-3.5" />
            Connected · {testState.system}
          </p>
        )}
        {testState.status === 'error' && renderError(testState.error)}
        {errorMessage}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => void handleTestSsh()}
            disabled={busy || testing}
          >
            {testing ? (
              <Spinner className="mr-2 size-4" />
            ) : (
              <Plug className="mr-2 size-4" />
            )}
            Test SSH
          </Button>
          <Button
            type="submit"
            className="flex-1"
            size="lg"
            disabled={busy || testing}
          >
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
        </div>
      </form>
    )
  }

  const setField =
    (key: keyof typeof EMPTY_URL_FORM) =>
    (event: ChangeEvent<HTMLInputElement>) =>
      setForm(current => ({ ...current, [key]: event.target.value }))

  return (
    <form className="space-y-4" onSubmit={handleUrlSubmit}>
      {tabs}
      <Field id="onboarding-remote-url" label="Web Access URL">
        <Input
          id="onboarding-remote-url"
          value={form.url}
          onChange={setField('url')}
          placeholder="https://jean.example.com/?token=..."
          required
          disabled={busy}
        />
      </Field>
      <Field id="onboarding-remote-token" label="Access token">
        <Input
          id="onboarding-remote-token"
          type="password"
          value={form.token}
          onChange={setField('token')}
          placeholder="Optional when included in the URL"
          disabled={busy}
        />
      </Field>
      <AdvancedOptions>
        <Field id="onboarding-remote-name" label="Name">
          <Input
            id="onboarding-remote-name"
            value={form.name}
            onChange={setField('name')}
            placeholder="Build server"
            disabled={busy}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          SSH is used to open remote projects in Zed.
        </p>
        <div className="grid grid-cols-[2fr_3fr_1fr] gap-3">
          <Field id="onboarding-remote-ssh-user" label="SSH user">
            <Input
              id="onboarding-remote-ssh-user"
              value={form.sshUser}
              onChange={setField('sshUser')}
              placeholder="ubuntu"
              autoComplete="username"
              disabled={busy}
            />
          </Field>
          <Field id="onboarding-remote-ssh-host" label="SSH host">
            <Input
              id="onboarding-remote-ssh-host"
              value={form.sshHost}
              onChange={setField('sshHost')}
              placeholder="URL host"
              disabled={busy}
            />
          </Field>
          <Field id="onboarding-remote-ssh-port" label="SSH port">
            <Input
              id="onboarding-remote-ssh-port"
              type="number"
              min={1}
              max={65535}
              value={form.sshPort}
              onChange={setField('sshPort')}
              disabled={busy}
            />
          </Field>
        </div>
      </AdvancedOptions>
      {errorMessage}
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {connecting && <Loader2 className="mr-2 size-4 animate-spin" />}
        Save & Connect
      </Button>
    </form>
  )
}

/** Hosts from `~/.ssh/config`: chips, or a dropdown when there are many. */
function SshHostPicker({
  hosts,
  selected,
  onPick,
  disabled,
}: {
  hosts: SshConfigHost[]
  selected: string
  onPick: (host: SshConfigHost) => void
  disabled: boolean
}) {
  const pickAlias = (alias: string) => {
    const host = hosts.find(item => item.alias === alias)
    if (host) onPick(host)
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">From SSH config</p>
      {hosts.length > MAX_HOST_CHIPS ? (
        <Select
          value={hosts.some(h => h.alias === selected) ? selected : ''}
          onValueChange={pickAlias}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className="w-full"
            aria-label="SSH config host"
          >
            <SelectValue placeholder="Pick a host" />
          </SelectTrigger>
          <SelectContent>
            {hosts.map(host => (
              <SelectItem key={host.alias} value={host.alias}>
                {host.alias}
                {host.hostName && (
                  <span className="text-muted-foreground">{host.hostName}</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {hosts.map(host => (
            <button
              key={host.alias}
              type="button"
              disabled={disabled}
              onClick={() => onPick(host)}
              aria-pressed={selected === host.alias}
              title={
                host.hostName
                  ? `${host.user ? `${host.user}@` : ''}${host.hostName}`
                  : undefined
              }
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                'hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:pointer-events-none disabled:opacity-50',
                selected === host.alias
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              {host.alias}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type PhaseState = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

function phaseState(phaseIndex: number, progress: InstallProgress): PhaseState {
  const activeIndex = INSTALL_PHASES.findIndex(p => p.id === progress.step)
  const phase = INSTALL_PHASES[phaseIndex]
  if (!phase) return 'pending'
  if (phaseIndex < activeIndex) {
    return progress.reached.includes(phase.id) ? 'done' : 'skipped'
  }
  if (phaseIndex === activeIndex) {
    if (progress.step === 'done') return 'done'
    return progress.failed ? 'failed' : 'active'
  }
  return 'pending'
}

/** Vertical checklist of install phases, driven by progress events. */
function InstallPhases({ progress }: { progress: InstallProgress }) {
  return (
    <ol
      aria-label="Install progress"
      className="space-y-1.5 rounded-md border bg-muted/40 px-3 py-2.5 text-sm"
    >
      {INSTALL_PHASES.map((phase, index) => {
        const state = phaseState(index, progress)
        return (
          <li key={phase.id} data-phase={phase.id} data-state={state}>
            <div className="flex items-center gap-2">
              <span className="flex size-4 shrink-0 items-center justify-center">
                {state === 'active' && <Spinner className="size-3.5" />}
                {state === 'done' && (
                  <Check className="size-4 text-green-600 dark:text-green-500" />
                )}
                {state === 'skipped' && (
                  <Check className="size-4 text-muted-foreground/60" />
                )}
                {state === 'failed' && (
                  <X className="size-4 text-destructive" />
                )}
                {state === 'pending' && (
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                )}
              </span>
              <span
                className={cn(
                  (state === 'pending' || state === 'skipped') &&
                    'text-muted-foreground',
                  state === 'failed' && 'text-destructive'
                )}
              >
                {phase.label}
                {state === 'skipped' && (
                  <span className="ml-1.5 text-xs">(not needed)</span>
                )}
              </span>
            </div>
            {(state === 'active' || state === 'failed') && progress.message && (
              <p className="ml-6 text-xs text-muted-foreground">
                {progress.message}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

/** Optional fields stay hidden until asked for. */
function AdvancedOptions({ children }: { children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
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
