/**
 * Shared CLI Setup Components
 *
 * Extracted from OnboardingDialog for reuse in both the onboarding wizard
 * and the individual CLI reinstall modal.
 */

/* eslint-disable no-console */
const dbg = (...args: unknown[]) => console.debug('[ONBOARDING:CLI]', ...args)

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { invoke, listen } from '@/lib/transport'
import {
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StandaloneTerminalSurface } from '@/components/chat/StandaloneTerminalSurface'
import { disposeTerminal, setOnStopped } from '@/lib/terminal-instances'
import { openExternal } from '@/lib/platform'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { InlineError } from './InlineError'
import { detectSignIn, type SignInDetection } from './sign-in-detection'

/** Keep only the tail of terminal output for sign-in detection. */
const SIGN_IN_BUFFER_LIMIT = 16 * 1024

interface CliVersionInfo {
  version: string
  tagName?: string
  tag_name?: string
  publishedAt?: string
  published_at?: string
  prerelease?: boolean
}

export function normalizeManualCliVersionInput(input: string): string {
  return input.trim().replace(/^v/i, '')
}

export function findMatchingCliVersion<T extends { version: string }>(
  versions: T[],
  input: string
): T | null {
  const normalizedInput = normalizeManualCliVersionInput(input)
  if (!normalizedInput) return null

  return (
    versions.find(
      version =>
        normalizeManualCliVersionInput(version.version) === normalizedInput
    ) ?? null
  )
}

export interface SetupStateProps {
  cliName: string
  versions: CliVersionInfo[]
  selectedVersion: string | null
  currentVersion?: string | null
  isLoading: boolean
  isError?: boolean
  onRetry?: () => void
  onVersionChange: (version: string) => void
  onCheckManualVersion?: (version: string) => Promise<boolean>
  onInstall: () => void
}

type ManualVersionStatus = 'idle' | 'checking' | 'valid' | 'invalid' | 'error'

export function SetupState({
  cliName,
  versions,
  selectedVersion,
  currentVersion,
  isLoading,
  isError,
  onRetry,
  onVersionChange,
  onCheckManualVersion,
  onInstall,
}: SetupStateProps) {
  const [manualVersion, setManualVersion] = useState('')
  const [manualVersionStatus, setManualVersionStatus] =
    useState<ManualVersionStatus>('idle')
  const normalizedManualVersion = normalizeManualCliVersionInput(manualVersion)
  const hasManualVersion = normalizedManualVersion.length > 0
  const manualVersionNeedsCheck =
    hasManualVersion && manualVersionStatus !== 'valid'

  const handleSelectVersion = useCallback(
    (version: string) => {
      setManualVersion('')
      setManualVersionStatus('idle')
      onVersionChange(version)
    },
    [onVersionChange]
  )

  const handleManualVersionChange = useCallback(
    (value: string) => {
      setManualVersion(value)
      if (!normalizeManualCliVersionInput(value) && versions[0]?.version) {
        onVersionChange(versions[0].version)
      }
    },
    [onVersionChange, versions]
  )

  const handleCheckManualVersion = useCallback(async () => {
    if (!normalizedManualVersion || !onCheckManualVersion) return

    setManualVersionStatus('checking')
    try {
      const exists = await onCheckManualVersion(normalizedManualVersion)
      if (exists) {
        onVersionChange(normalizedManualVersion)
        setManualVersionStatus('valid')
      } else {
        setManualVersionStatus('invalid')
      }
    } catch {
      setManualVersionStatus('error')
    }
  }, [normalizedManualVersion, onCheckManualVersion, onVersionChange])

  useEffect(() => {
    setManualVersionStatus('idle')
  }, [manualVersion])

  const renderManualVersionMessage = () => {
    if (!hasManualVersion) return null
    if (manualVersionStatus === 'valid') {
      return (
        <p className="text-xs text-muted-foreground">
          Version v{normalizedManualVersion} exists and can be installed.
        </p>
      )
    }
    if (manualVersionStatus === 'invalid') {
      return (
        <p className="text-xs text-destructive">
          Version not found at the download source.
        </p>
      )
    }
    if (manualVersionStatus === 'error') {
      return (
        <p className="text-xs text-destructive">
          Could not check this version. Try again.
        </p>
      )
    }
    return (
      <p className="text-xs text-muted-foreground">
        Click Check to verify this version exists at the download source.
      </p>
    )
  }

  const renderManualVersionInput = (disabled = false) => (
    <div className="space-y-1.5">
      <label
        htmlFor="cli-manual-version"
        className="text-xs text-muted-foreground"
      >
        Or enter a manual version
      </label>
      <div className="flex gap-2">
        <Input
          id="cli-manual-version"
          type="text"
          placeholder="2.1.98"
          value={manualVersion}
          onChange={e => handleManualVersionChange(e.target.value)}
          aria-invalid={
            manualVersionStatus === 'invalid' || manualVersionStatus === 'error'
          }
          disabled={disabled}
          className="font-mono"
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleCheckManualVersion}
          disabled={
            disabled ||
            !onCheckManualVersion ||
            !hasManualVersion ||
            manualVersionStatus === 'checking'
          }
        >
          {manualVersionStatus === 'checking' ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Check
        </Button>
      </div>
      {disabled ? (
        <p className="text-xs text-muted-foreground">
          Manual versions can be used after Jean loads enough CLI metadata to
          know which download source to check.
        </p>
      ) : (
        renderManualVersionMessage()
      )}
    </div>
  )

  return (
    <div className="space-y-6">
      {currentVersion && (
        <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
          <span className="text-sm">
            Currently installed:{' '}
            <span className="font-medium">v{currentVersion}</span>
          </span>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label
            htmlFor="cli-select-version"
            className="text-sm font-medium text-foreground"
          >
            Select Version
          </label>
          {!isLoading && !isError && versions.length > 0 && onRetry && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => onRetry()}
            >
              <RefreshCw className="size-3" />
              Refresh
            </Button>
          )}
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading versions...
          </div>
        ) : isError || (!isLoading && versions.length === 0) ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
              <span className="text-sm text-muted-foreground">
                Failed to load versions. This may be due to GitHub API rate
                limiting.
              </span>
              {onRetry && (
                <Button variant="ghost" size="sm" onClick={() => onRetry()}>
                  <RefreshCw className="size-3.5" />
                  Retry
                </Button>
              )}
            </div>
            {renderManualVersionInput(!onCheckManualVersion)}
          </div>
        ) : (
          <div className="space-y-3">
            <Select
              value={selectedVersion ?? undefined}
              onValueChange={handleSelectVersion}
            >
              <SelectTrigger id="cli-select-version" className="w-full">
                <SelectValue placeholder="Select a version" />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v, index) => (
                  <SelectItem key={v.version} value={v.version}>
                    v{v.version}
                    {index === 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (latest)
                      </span>
                    )}
                    {currentVersion === v.version && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (current)
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {renderManualVersionInput(!onCheckManualVersion)}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {cliName} will be installed separately in Jean&apos;s application data
          folder — it won&apos;t affect your global installation. Authentication
          and configuration from your global {cliName} setup will be used.
        </p>
      </div>

      <Button
        onClick={onInstall}
        disabled={!selectedVersion || isLoading || manualVersionNeedsCheck}
        className="w-full"
        size="lg"
      >
        <Download className="size-4" />
        {currentVersion ? 'Install Selected Version' : `Install ${cliName}`}
      </Button>
    </div>
  )
}

export interface InstallingStateProps {
  cliName: string
  progress: { stage: string; message: string; percent: number } | null
}

export function InstallingState({ cliName, progress }: InstallingStateProps) {
  const message = progress?.message ?? 'Preparing installation...'
  const percent = progress?.percent ?? 0

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="font-medium">{message}</p>
        <p className="text-sm text-muted-foreground mt-1">
          Please wait while {cliName} is being installed...
        </p>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-secondary rounded-full h-2">
        <div
          className="bg-primary h-2 rounded-full transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export interface ErrorStateProps {
  cliName: string
  error: Error | null
  onRetry: () => void
  onSkip?: () => void
}

export function ErrorState({
  cliName: _cliName,
  error,
  onRetry,
  onSkip,
}: ErrorStateProps) {
  const errorMessage = error instanceof Error ? error.message : String(error)

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="font-medium text-destructive">Installation Failed</p>
        <p className="text-sm text-muted-foreground mt-1">{errorMessage}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={onRetry} className="w-full" size="lg">
          Try Again
        </Button>
        {onSkip && (
          <Button
            onClick={onSkip}
            variant="outline"
            className="w-full"
            size="lg"
          >
            Skip for Now
          </Button>
        )}
      </div>
    </div>
  )
}

export interface AuthLoginStateProps {
  cliName: string
  terminalId: string
  command: string
  commandArgs?: string[] | null
  action?: 'login' | 'install'
  onComplete: () => void
  onRetry?: () => void
  onSkip?: () => void
}

export function AuthLoginState({
  cliName,
  terminalId,
  command,
  commandArgs,
  action = 'login',
  onComplete,
  onRetry,
  onSkip,
}: AuthLoginStateProps) {
  const actionLabel = action === 'install' ? 'Installation' : 'Login'
  const completionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const completionStartedRef = useRef(false)
  // Keyed by terminalId so a new terminal never shows the previous exit status.
  const [exitState, setExitState] = useState<{
    terminalId: string
    exitCode: number | null
    signal: string | null
  } | null>(null)
  const exitStatus = exitState?.terminalId === terminalId ? exitState : null

  const handleCompleteOnce = useCallback(() => {
    if (completionStartedRef.current) return
    completionStartedRef.current = true
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current)
      completionTimeoutRef.current = null
    }
    onComplete()
  }, [onComplete])

  useEffect(() => {
    dbg(
      'AuthLoginState MOUNTED:',
      cliName,
      'terminalId:',
      terminalId,
      'command:',
      command,
      'args:',
      commandArgs
    )
    return () =>
      dbg('AuthLoginState UNMOUNTED:', cliName, 'terminalId:', terminalId)
  }, [cliName, terminalId, command, commandArgs])

  // Auto-advance when the auth process exits successfully
  useEffect(() => {
    setOnStopped(terminalId, (exitCode, signal) => {
      dbg(
        'AuthLoginState terminal stopped:',
        cliName,
        'exitCode:',
        exitCode,
        'signal:',
        signal
      )
      if (exitCode === 0) {
        dbg('AuthLoginState: exit 0, calling onComplete in 1.5s')
        // Brief delay so user can see the success output
        if (!completionStartedRef.current) {
          completionTimeoutRef.current = setTimeout(handleCompleteOnce, 1500)
        }
        return
      }

      dbg('AuthLoginState: non-zero exit, showing error')
      setExitState({ terminalId, exitCode, signal })
    })
    return () => setOnStopped(terminalId, undefined)
  }, [terminalId, handleCompleteOnce, cliName])

  // Cleanup terminal on unmount
  useEffect(() => {
    return () => {
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current)
      }
      invoke('stop_terminal', { terminalId }).catch(() => {
        /* noop */
      })
      disposeTerminal(terminalId)
    }
  }, [terminalId])

  // Watch terminal output for a sign-in URL / device code.
  // Keyed by terminalId so a new terminal never shows the previous link.
  const [signInState, setSignInState] = useState<
    (SignInDetection & { terminalId: string }) | null
  >(null)
  const signIn = signInState?.terminalId === terminalId ? signInState : null
  const outputBufferRef = useRef('')

  useEffect(() => {
    if (action !== 'login') return
    outputBufferRef.current = ''
    const unlisten = listen<{ terminal_id: string; data: string }>(
      'terminal:output',
      event => {
        if (event.payload.terminal_id !== terminalId) return
        const buffer = (outputBufferRef.current + event.payload.data).slice(
          -SIGN_IN_BUFFER_LIMIT
        )
        outputBufferRef.current = buffer
        const { url, code } = detectSignIn(buffer)
        if (!url) return
        setSignInState(prev =>
          prev?.terminalId === terminalId &&
          prev.url === url &&
          prev.code === code
            ? prev
            : { terminalId, url, code }
        )
      }
    )
    return () => {
      unlisten
        .then(fn => fn())
        .catch(() => {
          /* noop */
        })
    }
  }, [terminalId, action])

  const [terminalVisible, setTerminalVisible] = useState(true)

  const handleOpenSignIn = useCallback(() => {
    if (!signIn?.url) return
    openExternal(signIn.url).catch(error => {
      toast.error(`Could not open browser: ${error}`)
    })
  }, [signIn?.url])

  const handleCopyCode = useCallback(() => {
    if (!signIn?.code) return
    copyToClipboard(signIn.code)
      .then(() => toast.success('Code copied'))
      .catch(error => toast.error(`Could not copy code: ${error}`))
  }, [signIn?.code])

  const exitLabel = exitStatus?.signal
    ? `signal ${exitStatus.signal}`
    : `exit ${exitStatus?.exitCode ?? 'unknown'}`

  return (
    <div className="space-y-3">
      <div className="text-center">
        <p className="font-medium">
          {action === 'install'
            ? `Installing ${cliName}`
            : `Sign in to ${cliName}`}
        </p>
        {action === 'login' && (
          <p className="mt-1 text-xs text-muted-foreground">
            Use ↑/↓ and Enter in the terminal if it asks.
          </p>
        )}
      </div>

      {signIn?.url && (
        <div
          className="space-y-2 rounded-lg border bg-muted/30 p-3"
          data-testid="sign-in-card"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleOpenSignIn} size="sm">
              <ExternalLink className="mr-1.5 size-3.5" />
              Open sign-in page
            </Button>
            {signIn.code && (
              <div className="flex items-center gap-1 rounded-md border bg-background py-0.5 pl-2.5 pr-0.5">
                <code
                  className="font-mono text-sm font-semibold tracking-wider select-all"
                  data-testid="sign-in-code"
                >
                  {signIn.code}
                </code>
                <Button
                  onClick={handleCopyCode}
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Copy code"
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
          {!signIn.code && (
            <p className="text-xs text-muted-foreground">
              Approve in your browser. Paste any code back here.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setTerminalVisible(value => !value)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={terminalVisible}
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform',
              terminalVisible && 'rotate-90'
            )}
          />
          {terminalVisible ? 'Hide terminal' : 'Show terminal'}
        </button>
        {/* Keep mounted when hidden: unmounting kills the PTY session. */}
        <div className={cn(!terminalVisible && 'hidden')}>
          <StandaloneTerminalSurface
            terminalId={terminalId}
            command={command}
            commandArgs={commandArgs}
            allowPasteInput={action === 'login'}
            className={
              signIn?.url
                ? 'h-[min(40dvh,280px)] min-h-[180px]'
                : 'h-[min(50dvh,380px)] min-h-[200px] sm:h-[360px]'
            }
          />
        </div>
      </div>

      {exitStatus && (
        <InlineError
          message={
            action === 'install'
              ? `Installation did not finish (${exitLabel}).`
              : `Sign-in did not finish (${exitLabel}).`
          }
          onRetry={onRetry}
        />
      )}

      <div className="flex gap-2">
        {exitStatus ? (
          <Button onClick={handleCompleteOnce} className="flex-1" size="lg">
            Check {actionLabel} Status
          </Button>
        ) : (
          <Button onClick={handleCompleteOnce} className="flex-1" size="lg">
            I&apos;ve Completed {actionLabel}
          </Button>
        )}
        {onSkip && (
          <Button
            onClick={onSkip}
            variant="outline"
            className={exitStatus ? '' : 'flex-1'}
            size="lg"
          >
            Skip for Now
          </Button>
        )}
      </div>
    </div>
  )
}
