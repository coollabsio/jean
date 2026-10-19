/**
 * One row per selected AI backend plus optional GitHub and GitLab CLIs.
 *
 * - Missing managed CLIs install automatically, all in parallel.
 * - CLIs found on PATH switch to the PATH binary automatically.
 * - Sign-in (and Cursor's terminal installer) is interactive, so only one
 *   row at a time expands with a terminal.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Check, Github, Loader2 } from '@/components/icons/reicon'
import { BetaBadge } from '@/components/ui/badge'
import { GitLabIcon } from '@/components/icons/GitLabIcon'
import {
  BackendLabel,
  getBackendIcon,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'
import { getCursorInstallCommand } from '@/services/cursor-cli'
import { cn } from '@/lib/utils'
import { AuthLoginState } from './CliSetupComponents'
import { InlineError, errorSummary } from './InlineError'
import type { AIBackend, CliCheck, CliFlow, CliType } from './cli-setup-flows'

type RowState =
  | 'ready'
  | 'checking'
  | 'installing'
  | 'error'
  | 'sign-in'
  | 'path'
  | 'missing'

type Flags = Partial<Record<CliType, true>>

function withFlag<T>(
  record: Partial<Record<CliType, T>>,
  cli: CliType,
  value: T | undefined
): Partial<Record<CliType, T>> {
  if (value === undefined) {
    if (!(cli in record)) return record
    return Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== cli)
    ) as Partial<Record<CliType, T>>
  }
  if (record[cli] === value) return record
  return { ...record, [cli]: value }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface SetupChecklistProps {
  flows: Record<CliType, CliFlow>
  backends: AIBackend[]
  onSkip: (backend: AIBackend) => void
  terminalIdFor: (id: string) => string
  loginSeed: number
  /** Explicit server for Cursor's install command (undefined = local). */
  cursorServerId: string | undefined
}

export function SetupChecklist({
  flows,
  backends,
  onSkip,
  terminalIdFor,
  loginSeed,
  cursorServerId,
}: SetupChecklistProps) {
  const [ghSkipped, setGhSkipped] = useState(false)
  const [glabSkipped, setGlabSkipped] = useState(false)
  const rows: CliType[] = [
    ...backends,
    ...(ghSkipped ? [] : (['gh'] as const)),
    ...(glabSkipped ? [] : (['glab'] as const)),
  ]

  // Auto actions already started during this checklist visit.
  const startedRef = useRef(new Set<string>())
  const [busy, setBusy] = useState<
    Partial<Record<CliType, 'install' | 'path'>>
  >({})
  const [pathTried, setPathTried] = useState<Flags>({})
  // Fresh results from install / PATH / sign-in checks. Query data can land a
  // tick later, so rows wait ("checking") instead of acting on stale flows.
  const [confirmed, setConfirmed] = useState<
    Partial<Record<CliType, CliCheck>>
  >({})
  const [errors, setErrors] = useState<Partial<Record<CliType, unknown>>>({})
  const [checking, setChecking] = useState<Flags>({})
  const [notSignedIn, setNotSignedIn] = useState<Flags>({})
  const [loginAttempt, setLoginAttempt] = useState<
    Partial<Record<CliType, number>>
  >({})
  const [priority, setPriority] = useState<CliType | null>(null)
  const [cursorInstall, setCursorInstall] = useState<{
    command: string
    args: string[]
    attempt: number
  } | null>(null)
  const [cursorInstallError, setCursorInstallError] = useState<string | null>(
    null
  )

  const startInstall = useCallback((cli: CliType, flow: CliFlow) => {
    startedRef.current.add(`${cli}:install`)
    setErrors(prev => withFlag(prev, cli, undefined))
    setBusy(prev => withFlag(prev, cli, 'install'))
    flow
      .install()
      .then(check => setConfirmed(prev => withFlag(prev, cli, check)))
      .catch((error: unknown) =>
        setErrors(prev => withFlag<unknown>(prev, cli, error ?? 'Failed'))
      )
      .finally(() => setBusy(prev => withFlag(prev, cli, undefined)))
  }, [])

  const startUsePath = useCallback((cli: CliType, flow: CliFlow) => {
    startedRef.current.add(`${cli}:path`)
    setBusy(prev => withFlag(prev, cli, 'path'))
    flow
      .usePath()
      .then(check => setConfirmed(prev => withFlag(prev, cli, check)))
      .catch(() => undefined)
      .finally(() => {
        setBusy(prev => withFlag(prev, cli, undefined))
        setPathTried(prev => withFlag(prev, cli, true))
      })
  }, [])

  // Kick off PATH adoption and managed installs without user action.
  useEffect(() => {
    for (const cli of rows) {
      const flow = flows[cli]
      if (flow.statusLoading || flow.installed || flow.isInstalling) continue
      if (busy[cli] || cli in errors || confirmed[cli]?.installed) continue
      if (flow.pathFound && !pathTried[cli]) {
        if (!startedRef.current.has(`${cli}:path`)) startUsePath(cli, flow)
        continue
      }
      if (
        flow.installMode === 'managed' &&
        !startedRef.current.has(`${cli}:install`)
      ) {
        startInstall(cli, flow)
      }
    }
  })

  const startCursorInstall = useCallback(async () => {
    try {
      const command = await getCursorInstallCommand(cursorServerId)
      setCursorInstallError(null)
      setCursorInstall(prev => ({
        command: command.command,
        args: command.args,
        attempt: (prev?.attempt ?? 0) + 1,
      }))
      setPriority('cursor')
    } catch (error) {
      setCursorInstallError(errorSummary(error))
    }
  }, [cursorServerId])

  const handleCursorInstallComplete = async () => {
    const result = await flows.cursor.refetch()
    setConfirmed(prev => withFlag(prev, 'cursor', result))
    setCursorInstall(null)
    if (!result.installed) setCursorInstallError('Cursor Agent not found.')
  }

  const handleLoginComplete = async (cli: CliType) => {
    setChecking(prev => withFlag(prev, cli, true))
    try {
      const result = await flows[cli].refetch()
      setConfirmed(prev => withFlag(prev, cli, result))
      if (!result.authenticated) {
        setNotSignedIn(prev => withFlag(prev, cli, true))
      }
    } finally {
      setChecking(prev => withFlag(prev, cli, undefined))
    }
  }

  const retryLogin = (cli: CliType) => {
    setNotSignedIn(prev => withFlag(prev, cli, undefined))
    setLoginAttempt(prev => ({ ...prev, [cli]: (prev[cli] ?? 0) + 1 }))
  }

  const rowState = (cli: CliType): RowState => {
    const flow = flows[cli]
    if (cli in errors) return 'error'
    if (busy[cli] === 'install' || flow.isInstalling) return 'installing'
    if (busy[cli] === 'path' || flow.statusLoading || checking[cli]) {
      return 'checking'
    }
    const fresh = confirmed[cli]
    if (
      fresh &&
      ((fresh.installed && !flow.installed) ||
        (fresh.authenticated && !flow.authenticated))
    ) {
      return 'checking'
    }
    if (flow.installed) {
      if (flow.authLoading) return 'checking'
      return flow.authenticated ? 'ready' : 'sign-in'
    }
    if (flow.pathFound && !pathTried[cli]) return 'path'
    return 'missing'
  }

  const states = Object.fromEntries(
    rows.map(cli => [cli, rowState(cli)])
  ) as Record<CliType, RowState>

  // Interactive rows share one slot. A row checking its sign-in keeps the
  // slot so the next terminal doesn't mount and get killed again.
  const interactive = rows.filter(
    cli =>
      states[cli] === 'sign-in' ||
      (checking[cli] && flows[cli].installed) ||
      (cli === 'cursor' && states[cli] === 'missing' && !!cursorInstall)
  )
  const active =
    priority && interactive.includes(priority)
      ? priority
      : (interactive[0] ?? null)

  const renderActive = (cli: CliType) => {
    const flow = flows[cli]
    if (checking[cli]) {
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Checking sign-in…
        </p>
      )
    }
    if (cli === 'cursor' && !flow.installed && cursorInstall) {
      const terminalId = terminalIdFor(
        `onboarding-cursor-install-${loginSeed}-${cursorInstall.attempt}`
      )
      return (
        <AuthLoginState
          key={terminalId}
          cliName="Cursor Agent"
          terminalId={terminalId}
          command={cursorInstall.command}
          commandArgs={cursorInstall.args}
          action="install"
          onComplete={handleCursorInstallComplete}
          onRetry={startCursorInstall}
        />
      )
    }
    if (notSignedIn[cli]) {
      return (
        <InlineError
          message="Not signed in yet."
          onRetry={() => retryLogin(cli)}
        />
      )
    }
    if (!flow.loginCommand) {
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Locating {flow.label}…
        </p>
      )
    }
    const terminalId = terminalIdFor(
      `onboarding-${cli}-login-${loginSeed}-${loginAttempt[cli] ?? 0}`
    )
    return (
      <AuthLoginState
        key={terminalId}
        cliName={flow.label}
        terminalId={terminalId}
        command={flow.loginCommand}
        commandArgs={flow.loginArgs}
        onComplete={() => void handleLoginComplete(cli)}
        onRetry={() => retryLogin(cli)}
      />
    )
  }

  return (
    <ul className="space-y-2">
      {rows.map(cli => {
        const flow = flows[cli]
        const state = states[cli]
        const isActive = active === cli
        const Icon =
          cli === 'gh' ? Github : cli === 'glab' ? GitLabIcon : getBackendIcon(cli)
        const rowLabel =
          cli === 'gh' || cli === 'glab' ? flow.label : getBackendPlainLabel(cli)
        const canSkip =
          state !== 'ready' &&
          (cli === 'gh' || cli === 'glab' || backends.length > 1)
        const waiting = interactive.includes(cli) && !isActive
        const cursorMissing = cli === 'cursor' && state === 'missing'

        let status: string
        if (state === 'ready') status = 'Ready'
        else if (state === 'checking') status = 'Checking…'
        else if (state === 'installing')
          status = flow.progress?.message ?? 'Installing…'
        else if (state === 'error') status = 'Install failed'
        else if (state === 'path') status = 'Found on PATH'
        else if (waiting) status = 'Waiting'
        else if (state === 'sign-in') status = 'Sign in'
        else if (cursorMissing)
          status = cursorInstall ? 'Installing…' : 'Not installed'
        else status = 'Installing…'

        const spinning =
          state === 'checking' ||
          state === 'installing' ||
          state === 'path' ||
          (state === 'missing' && !cursorMissing)

        return (
          <li
            key={cli}
            aria-label={rowLabel}
            data-testid={`setup-row-${cli}`}
            className={cn(
              'rounded-lg border p-3 transition-colors',
              isActive && 'border-primary bg-primary/5'
            )}
          >
            <div className="flex items-center gap-3">
              <Icon className="size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {cli === 'gh' || cli === 'glab' ? (
                    <span className="inline-flex items-center gap-1.5">
                      {flow.label}
                      {cli === 'glab' && <BetaBadge />}
                    </span>
                  ) : (
                    <BackendLabel backend={cli} />
                  )}
                  {(cli === 'gh' || cli === 'glab') && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      optional
                    </span>
                  )}
                </div>
                <div
                  className={cn(
                    'truncate text-xs',
                    state === 'ready' ? 'text-success' : 'text-muted-foreground'
                  )}
                >
                  {status}
                </div>
              </div>
              {canSkip && (
                <button
                  type="button"
                  onClick={() => {
                    if (cli === 'gh') setGhSkipped(true)
                    else if (cli === 'glab') setGlabSkipped(true)
                    else onSkip(cli as AIBackend)
                  }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Skip
                </button>
              )}
              {state === 'ready' && (
                <Check aria-hidden className="size-4 shrink-0 text-success" />
              )}
              {spinning && (
                <Loader2
                  aria-hidden
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
              )}
              {waiting && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPriority(cli)}
                >
                  {cursorMissing ? 'Install' : 'Sign in'}
                </Button>
              )}
              {cursorMissing && !cursorInstall && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void startCursorInstall()}
                >
                  Install
                </Button>
              )}
            </div>

            {state === 'installing' && (flow.progress?.percent ?? 0) > 0 && (
              <div className="mt-2 h-1 w-full rounded-full bg-muted">
                <div
                  className="h-1 rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${flow.progress?.percent ?? 0}%` }}
                />
              </div>
            )}

            {state === 'error' && (
              <InlineError
                className="mt-2"
                message={errorSummary(errors[cli])}
                details={errorText(errors[cli])}
                onRetry={() => startInstall(cli, flow)}
              />
            )}

            {cursorMissing && !cursorInstall && cursorInstallError && (
              <InlineError
                className="mt-2"
                message={cursorInstallError}
                onRetry={() => void startCursorInstall()}
              />
            )}

            {isActive && (
              <div className="mt-3 animate-in fade-in-0 duration-200 motion-reduce:animate-none">
                {renderActive(cli)}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
