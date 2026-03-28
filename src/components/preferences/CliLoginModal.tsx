/**
 * CLI Login Modal
 *
 * Modal with embedded xterm terminal for CLI login flows.
 * Used for `claude` and `gh auth login` commands that require
 * interactive terminal access.
 */

import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import { invoke, listen } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { claudeCliQueryKeys } from '@/services/claude-cli'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { codexCliQueryKeys } from '@/services/codex-cli'
import { opencodeCliQueryKeys } from '@/services/opencode-cli'
import { githubQueryKeys } from '@/services/github'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'
import { useShallow } from 'zustand/react/shallow'
import { useTerminal } from '@/hooks/useTerminal'
import { disposeTerminal, setOnStopped } from '@/lib/terminal-instances'

export function CliLoginModal() {
  const [retryKey, setRetryKey] = useState(0)
  const { isOpen, cliType, command, commandArgs, action, closeModal } =
    useUIStore(
      useShallow(state => ({
        isOpen: state.cliLoginModalOpen,
        cliType: state.cliLoginModalType,
        command: state.cliLoginModalCommand,
        commandArgs: state.cliLoginModalCommandArgs,
        action: state.cliLoginModalAction,
        closeModal: state.closeCliLoginModal,
      }))
    )

  // Only render when open to avoid unnecessary terminal setup
  if (!isOpen || !command) return null

  return (
    <CliLoginModalContent
      key={retryKey}
      cliType={cliType}
      command={command}
      commandArgs={commandArgs}
      action={action}
      onClose={closeModal}
      onRetry={() => setRetryKey(k => k + 1)}
    />
  )
}

interface CliLoginModalContentProps {
  cliType: 'claude' | 'gh' | 'codex' | 'opencode' | null
  command: string
  commandArgs: string[] | null
  action: 'login' | 'update'
  onClose: () => void
  onRetry: () => void
}

function CliLoginModalContent({
  cliType,
  command,
  commandArgs,
  action,
  onClose,
  onRetry,
}: CliLoginModalContentProps) {
  const queryClient = useQueryClient()
  const initialized = useRef(false)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [exitStatus, setExitStatus] = useState<{
    exitCode: number | null
    signal: string | null
  } | null>(null)

  const cliName =
    cliType === 'claude'
      ? 'Claude CLI'
      : cliType === 'codex'
        ? 'Codex CLI'
        : cliType === 'opencode'
          ? 'OpenCode CLI'
          : 'GitHub CLI'

  // Generate unique terminal ID for this login session
  const terminalId = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const id = `cli-login-${Date.now()}`
    return id
  }, [])

  // Buffer last N lines of terminal output for debug logging on error
  const outputBufferRef = useRef<string[]>([])
  const MAX_OUTPUT_LINES = 50

  useEffect(() => {
    const unlisten = listen<{ terminal_id: string; data: string }>(
      'terminal:output',
      event => {
        if (event.payload.terminal_id !== terminalId) return
        const lines = event.payload.data.split('\n')
        outputBufferRef.current.push(...lines)
        if (outputBufferRef.current.length > MAX_OUTPUT_LINES) {
          outputBufferRef.current =
            outputBufferRef.current.slice(-MAX_OUTPUT_LINES)
        }
      }
    )
    return () => {
      unlisten.then(fn => fn())
    }
  }, [terminalId])

  // Use a synthetic worktreeId for CLI login (not associated with any real worktree)
  const { initTerminal, fit } = useTerminal({
    terminalId,
    worktreeId: 'cli-login', // Synthetic worktreeId for CLI login terminals
    worktreePath: '/tmp', // CLI commands don't depend on cwd
    command,
    commandArgs,
  })

  // Use callback ref to detect when container is mounted (Dialog uses portal)
  const containerCallbackRef = useCallback(
    (container: HTMLDivElement | null) => {
      // Cleanup previous observer if any
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }

      if (!container) return

      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        const { width, height } = entry?.contentRect ?? { width: 0, height: 0 }

        console.log(
          `[CliLoginModal] ResizeObserver: ${width}x${height}, initialized=${initialized.current}`
        )

        if (!entry || width === 0 || height === 0) {
          return
        }

        // Initialize on first valid size
        if (!initialized.current) {
          initialized.current = true
          console.log(
            `[CliLoginModal] Initializing terminal at ${width}x${height}`
          )
          initTerminal(container)
          return
        }

        // Debounced resize - fit is stable so this is fine
        fit()
      })

      observer.observe(container)
      observerRef.current = observer
    },
    [initTerminal, fit]
  )

  // Cleanup observer and terminal on unmount (needed for retry remount)
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
      invoke('stop_terminal', { terminalId }).catch(() => {
        // Terminal may already be stopped
      })
      disposeTerminal(terminalId)
    }
  }, [terminalId])

  // Cleanup terminal when modal closes
  const handleOpenChange = useCallback(
    async (open: boolean) => {
      if (!open) {
        // Stop PTY process
        try {
          await invoke('stop_terminal', { terminalId })
        } catch {
          // Terminal may already be stopped
        }
        // Dispose xterm instance
        disposeTerminal(terminalId)

        // Invalidate caches so views auto-refetch after login/update
        if (cliType === 'claude') {
          queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all })
        } else if (cliType === 'gh') {
          queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all })
          queryClient.invalidateQueries({ queryKey: githubQueryKeys.all })
        } else if (cliType === 'codex') {
          queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all })
        } else if (cliType === 'opencode') {
          queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.all })
        }

        onClose()
      }
    },
    [terminalId, onClose, cliType, queryClient]
  )

  // Auto-close modal on success, show error on failure
  useEffect(() => {
    setOnStopped(terminalId, (exitCode, signal) => {
      const output = outputBufferRef.current.join('\n').trim()
      const logBase =
        `[CliLoginModal] ${cliName} exited code=${exitCode} signal=${signal ?? 'none'}` +
        ` command=${command} args=${JSON.stringify(commandArgs)}`
      const logOutput = output
        ? `\nTerminal output (last ${MAX_OUTPUT_LINES} lines):\n${output}`
        : '\nNo terminal output captured'

      if (exitCode === 0) {
        logger.debug(logBase + logOutput)
        setTimeout(() => handleOpenChange(false), 1500)
      } else {
        logger.error(logBase + logOutput)
        setExitStatus({ exitCode, signal })
      }
    })
    return () => setOnStopped(terminalId, undefined)
  }, [terminalId, handleOpenChange])

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent className="!w-screen !h-dvh !max-w-screen !rounded-none sm:!w-[calc(100vw-64px)] sm:!max-w-[calc(100vw-64px)] sm:!h-[calc(100vh-64px)] sm:!rounded-lg flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {cliName} {action === 'update' ? 'Update' : 'Login'}
          </DialogTitle>
        </DialogHeader>

        <div
          ref={containerCallbackRef}
          className="flex-1 min-h-0 w-full rounded-md bg-[#1a1a1a] overflow-hidden"
        />

        {exitStatus && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <div>
              <p className="text-sm font-medium text-destructive">
                {action === 'update' ? 'Update' : 'Login'} process exited
                unexpectedly
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {exitStatus.signal
                  ? `Signal: ${exitStatus.signal}`
                  : `Exit code: ${exitStatus.exitCode ?? 'unknown'}`}
              </p>
            </div>
            <Button onClick={onRetry} variant="outline" size="sm">
              Retry
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
