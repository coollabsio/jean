/**
 * Shared CLI Setup Components
 *
 * Extracted from OnboardingDialog for reuse in both the onboarding wizard
 * and the individual CLI reinstall modal.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTerminal } from '@/hooks/useTerminal'
import { disposeTerminal, setOnStopped } from '@/lib/terminal-instances'

export interface SetupStateProps {
  cliName: string
  versions: {
    version: string
    tagName?: string
    tag_name?: string
    publishedAt?: string
    published_at?: string
  }[]
  selectedVersion: string | null
  currentVersion?: string | null
  isLoading: boolean
  isError?: boolean
  onRetry?: () => void
  onVersionChange: (version: string) => void
  onInstall: () => void
}

export function SetupState({
  cliName,
  versions,
  selectedVersion,
  currentVersion,
  isLoading,
  isError,
  onRetry,
  onVersionChange,
  onInstall,
}: SetupStateProps) {
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
          <label className="text-sm font-medium text-foreground">
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
          <div className="flex items-center justify-between gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
            <span className="text-sm text-muted-foreground">
              Failed to load versions. This may be due to GitHub API rate limiting.
            </span>
            {onRetry && (
              <Button variant="ghost" size="sm" onClick={() => onRetry()}>
                <RefreshCw className="size-3.5" />
                Retry
              </Button>
            )}
          </div>
        ) : (
          <Select
            value={selectedVersion ?? undefined}
            onValueChange={onVersionChange}
          >
            <SelectTrigger className="w-full">
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
        )}
        <p className="text-xs text-muted-foreground">
          {cliName} will be installed separately in Jean&apos;s application data
          folder — it won&apos;t affect your global installation. Authentication
          and configuration from your global {cliName} setup will be used.
        </p>
      </div>

      <Button
        onClick={onInstall}
        disabled={!selectedVersion || isLoading}
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

export interface AuthCheckingStateProps {
  cliName: string
}

export function AuthCheckingState({ cliName }: AuthCheckingStateProps) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="font-medium">Checking Authentication</p>
        <p className="text-sm text-muted-foreground mt-1">
          Verifying {cliName} login status...
        </p>
      </div>
    </div>
  )
}

export interface AuthLoginStateProps {
  cliName: string
  terminalId: string
  command: string
  commandArgs?: string[] | null
  onComplete: () => void
  onRetry?: () => void
  onSkip?: () => void
}

export function AuthLoginState({
  cliName,
  terminalId,
  command,
  commandArgs,
  onComplete,
  onRetry,
  onSkip,
}: AuthLoginStateProps) {
  const observerRef = useRef<ResizeObserver | null>(null)
  const initialized = useRef(false)
  const [exitStatus, setExitStatus] = useState<{
    exitCode: number | null
    signal: string | null
  } | null>(null)

  const { initTerminal, fit } = useTerminal({
    terminalId,
    worktreeId: 'cli-login',
    worktreePath: '/tmp',
    command,
    commandArgs,
  })

  const containerCallbackRef = useCallback(
    (container: HTMLDivElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }

      if (!container) return

      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (!entry || entry.contentRect.width === 0) return

        if (!initialized.current) {
          initialized.current = true
          initTerminal(container)
          return
        }

        fit()
      })

      observer.observe(container)
      observerRef.current = observer
    },
    [initTerminal, fit]
  )

  // Auto-advance when the auth process exits successfully
  useEffect(() => {
    setOnStopped(terminalId, (exitCode, signal) => {
      if (exitCode === 0) {
        // Brief delay so user can see the success output
        setTimeout(() => onComplete(), 1500)
        return
      }

      setExitStatus({ exitCode, signal })
    })
    return () => setOnStopped(terminalId, undefined)
  }, [terminalId, onComplete])

  useEffect(() => {
    setExitStatus(null)
  }, [terminalId])

  // Cleanup observer and terminal on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
      invoke('stop_terminal', { terminalId }).catch(() => {
        /* noop */
      })
      disposeTerminal(terminalId)
    }
  }, [terminalId])

  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="font-medium">{cliName} Login Required</p>
        <p className="text-sm text-muted-foreground mt-1">
          Complete the authentication process below.
        </p>
      </div>

      <div
        ref={containerCallbackRef}
        className="w-full h-[300px] rounded-md bg-[#1a1a1a] overflow-hidden"
      />

      {exitStatus && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">
            Login process exited unexpectedly
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {exitStatus.signal
              ? `Signal: ${exitStatus.signal}`
              : `Exit code: ${exitStatus.exitCode ?? 'unknown'}`}
          </p>
        </div>
      )}

      <div className="flex gap-2">
        {exitStatus ? (
          <>
            <Button onClick={onComplete} className="flex-1" size="lg">
              Check Login Status
            </Button>
            {onRetry && (
              <Button
                onClick={onRetry}
                variant="outline"
                className="flex-1"
                size="lg"
              >
                Retry Login
              </Button>
            )}
          </>
        ) : (
          <Button onClick={onComplete} className="flex-1" size="lg">
            I&apos;ve Completed Login
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
