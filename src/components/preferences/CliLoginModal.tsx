/**
 * CLI Login Modal
 *
 * Modal with embedded xterm terminal for CLI login flows.
 * Used for `claude` and `gh auth login` commands that require
 * interactive terminal access.
 */

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import { invoke, listen } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { claudeCliQueryKeys } from '@/services/claude-cli'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { codexCliQueryKeys } from '@/services/codex-cli'
import { opencodeCliQueryKeys } from '@/services/opencode-cli'
import { cursorCliQueryKeys } from '@/services/cursor-cli'
import { piCliQueryKeys } from '@/services/pi-cli'
import { commandcodeCliQueryKeys } from '@/services/commandcode-cli'
import { grokCliQueryKeys } from '@/services/grok-cli'
import { kimiCliQueryKeys } from '@/services/kimi-cli'
import { antigravityCliQueryKeys } from '@/services/antigravity-cli'
import { coderabbitCliQueryKeys } from '@/services/coderabbit-cli'
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
import { disposeTerminal, setOnStopped } from '@/lib/terminal-instances'
import { BackendLabel } from '@/components/ui/backend-label'
import { generateId } from '@/lib/uuid'
import { StandaloneTerminalSurface } from '@/components/chat/StandaloneTerminalSurface'

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
  cliType:
    | 'claude'
    | 'gh'
    | 'codex'
    | 'opencode'
    | 'cursor'
    | 'pi'
    | 'commandcode'
    | 'grok'
    | 'kimi'
    | 'antigravity'
    | 'coderabbit'
    | null
  command: string
  commandArgs: string[] | null
  action: 'login' | 'update' | 'install'
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
  const [exitStatus, setExitStatus] = useState<{
    exitCode: number | null
    signal: string | null
  } | null>(null)

  const cliName =
    cliType === 'claude'
      ? 'Claude CLI'
      : cliType === 'codex'
        ? 'Codex CLI'
        : cliType === 'coderabbit'
          ? 'CodeRabbit CLI'
          : cliType === 'opencode'
            ? 'OpenCode CLI'
            : cliType === 'cursor'
              ? 'Cursor CLI'
              : cliType === 'pi'
                ? 'PI CLI'
                : cliType === 'commandcode'
                  ? 'Command Code CLI'
                  : cliType === 'grok'
                    ? 'Grok CLI'
                    : cliType === 'kimi'
                      ? 'Kimi Code'
                      : cliType === 'antigravity'
                        ? 'Antigravity CLI'
                        : 'GitHub CLI'
  const cliTitle =
    cliType === 'cursor' ||
    cliType === 'pi' ||
    cliType === 'commandcode' ||
    cliType === 'grok' ? (
      <span className="inline-flex items-center gap-2">
        <BackendLabel backend={cliType} />
        <span>CLI</span>
      </span>
    ) : cliType === 'kimi' || cliType === 'antigravity' ? (
      <BackendLabel backend={cliType} />
    ) : (
      cliName
    )

  // Generate unique terminal ID for this login session
  const [terminalId] = useState(() => `cli-login-${generateId()}`)

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

  // Cleanup terminal on unmount (needed for retry remount)
  useEffect(() => {
    return () => {
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
        } else if (cliType === 'cursor') {
          queryClient.invalidateQueries({ queryKey: cursorCliQueryKeys.all })
        } else if (cliType === 'pi') {
          queryClient.invalidateQueries({ queryKey: piCliQueryKeys.all })
        } else if (cliType === 'commandcode') {
          queryClient.invalidateQueries({
            queryKey: commandcodeCliQueryKeys.all,
          })
        } else if (cliType === 'grok') {
          queryClient.invalidateQueries({ queryKey: grokCliQueryKeys.all })
        } else if (cliType === 'kimi') {
          queryClient.invalidateQueries({ queryKey: kimiCliQueryKeys.all })
        } else if (cliType === 'antigravity') {
          queryClient.invalidateQueries({ queryKey: antigravityCliQueryKeys.all })
        } else if (cliType === 'coderabbit') {
          queryClient.invalidateQueries({
            queryKey: coderabbitCliQueryKeys.all,
          })
        }

        // Dismiss any lingering update toast for this CLI type
        toast.dismiss(`cli-update-${cliType}`)

        onClose()
      }
    },
    [terminalId, onClose, cliType, queryClient]
  )

  // Auto-close modal on success, show error on failure
  const onLoginSuccessClose = useEffectEvent(() => {
    handleOpenChange(false)
  })

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
        setTimeout(() => onLoginSuccessClose(), 1500)
      } else {
        logger.error(logBase + logOutput)
        setExitStatus({ exitCode, signal })
      }
    })
    return () => setOnStopped(terminalId, undefined)
  }, [terminalId, cliName, command, commandArgs])

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent className="!w-screen !h-dvh !max-w-screen !rounded-none sm:!w-[calc(100vw-64px)] sm:!max-w-[calc(100vw-64px)] sm:!h-[calc(100vh-64px)] sm:!rounded-lg flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {cliTitle}{' '}
            {action === 'update'
              ? 'Update'
              : action === 'install'
                ? 'Install'
                : 'Login'}
          </DialogTitle>
        </DialogHeader>

        <StandaloneTerminalSurface
          terminalId={terminalId}
          command={command}
          commandArgs={commandArgs}
          className="min-h-0 flex-1"
        />

        {exitStatus && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <div>
              <p className="text-sm font-medium text-destructive">
                {action === 'update'
                  ? 'Update'
                  : action === 'install'
                    ? 'Install'
                    : 'Login'}{' '}
                process exited unexpectedly
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
