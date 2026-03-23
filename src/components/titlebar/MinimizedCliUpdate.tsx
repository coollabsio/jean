/**
 * Minimized CLI Update Indicator
 *
 * Inline titlebar indicator shown when a CLI upgrade modal is minimized.
 * Tracks progress via Tauri events and auto-clears on completion.
 * Clicking the indicator re-opens the upgrade modal.
 */

import { useEffect, useState, useCallback } from 'react'
import { listen, invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, X } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { claudeCliQueryKeys } from '@/services/claude-cli'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { codexCliQueryKeys } from '@/services/codex-cli'
import { opencodeCliQueryKeys } from '@/services/opencode-cli'
import { githubQueryKeys } from '@/services/github'
import { disposeTerminal, setOnStopped } from '@/lib/terminal-instances'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const CLI_NAMES: Record<string, string> = {
  claude: 'Claude CLI',
  gh: 'GitHub CLI',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
}

function invalidateCliQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  type: string
) {
  if (type === 'claude') {
    queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all })
  } else if (type === 'gh') {
    queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all })
    queryClient.invalidateQueries({ queryKey: githubQueryKeys.all })
  } else if (type === 'codex') {
    queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all })
  } else if (type === 'opencode') {
    queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.all })
  }
}

export function MinimizedCliUpdate() {
  const minimized = useUIStore(state => state.minimizedCliUpdate)
  const clearMinimizedCliUpdate = useUIStore(
    state => state.clearMinimizedCliUpdate
  )
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<{
    stage: string
    message: string
    percent: number
  } | null>(null)

  const handleComplete = useCallback(
    (success: boolean) => {
      if (!minimized) return
      const cliName = CLI_NAMES[minimized.type] ?? minimized.type
      if (success) {
        toast.success(`${cliName} updated successfully`)
      } else {
        toast.error(`${cliName} update failed`)
      }
      invalidateCliQueries(queryClient, minimized.type)
      clearMinimizedCliUpdate()
    },
    [minimized, queryClient, clearMinimizedCliUpdate]
  )

  // Reinstall mode: listen to install-progress events
  useEffect(() => {
    if (!minimized || minimized.mode !== 'reinstall') return

    const eventName = `${minimized.type}-cli:install-progress`
    const unlisten = listen<{
      stage: string
      message: string
      percent: number
    }>(eventName, event => {
      setProgress(event.payload)
      if (event.payload.stage === 'complete') {
        handleComplete(true)
      }
    })
    return () => {
      unlisten.then(fn => fn())
    }
  }, [minimized?.type, minimized?.mode, handleComplete])

  // Login mode: listen to terminal stopped
  useEffect(() => {
    if (!minimized || minimized.mode !== 'login' || !minimized.terminalId)
      return

    const terminalId = minimized.terminalId
    setOnStopped(terminalId, (exitCode: number | null) => {
      const success = exitCode === 0
      handleComplete(success)
      // Cleanup the PTY
      invoke('stop_terminal', { terminalId }).catch(() => {
        // Terminal may already be stopped
      })
      disposeTerminal(terminalId)
    })
    return () => setOnStopped(terminalId, undefined)
  }, [minimized?.terminalId, minimized?.mode, handleComplete])

  // Reset progress when minimized state changes
  useEffect(() => {
    setProgress(null)
  }, [minimized?.type, minimized?.mode])

  // Restore: re-open the upgrade modal
  const handleRestore = useCallback(() => {
    if (!minimized) return
    const { openCliUpdateModal } = useUIStore.getState()

    if (minimized.mode === 'reinstall') {
      // Re-open reinstall modal — it will pick up fresh progress events
      clearMinimizedCliUpdate()
      openCliUpdateModal(minimized.type)
    } else if (minimized.mode === 'login') {
      // For login mode, the PTY is still running but the terminal UI was detached.
      // Re-opening would create a new terminal, so we just keep showing the indicator.
      // User can dismiss with X when done.
    }
  }, [minimized, clearMinimizedCliUpdate])

  const handleDismiss = useCallback(() => {
    if (!minimized) return
    // For login mode, stop PTY and dispose terminal
    if (minimized.mode === 'login' && minimized.terminalId) {
      setOnStopped(minimized.terminalId, undefined)
      invoke('stop_terminal', { terminalId: minimized.terminalId }).catch(
        () => {
          // Terminal may already be stopped
        }
      )
      disposeTerminal(minimized.terminalId)
    }
    clearMinimizedCliUpdate()
  }, [minimized, clearMinimizedCliUpdate])

  if (!minimized) return null

  const cliName = CLI_NAMES[minimized.type] ?? minimized.type
  const progressPercent =
    minimized.mode === 'reinstall' && progress ? `${progress.percent}%` : null
  const isRestorable = minimized.mode === 'reinstall'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role={isRestorable ? 'button' : undefined}
          tabIndex={isRestorable ? 0 : undefined}
          onClick={isRestorable ? handleRestore : undefined}
          onKeyDown={
            isRestorable
              ? e => {
                  if (e.key === 'Enter') handleRestore()
                }
              : undefined
          }
          className={`mr-1.5 flex items-center gap-1.5 rounded-md bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary ${isRestorable ? 'cursor-pointer hover:bg-primary/25' : ''}`}
        >
          <Loader2 className="size-3 animate-spin" />
          <span className="truncate max-w-[120px]">
            {cliName} {progressPercent ?? 'updating...'}
          </span>
          <button
            onClick={e => {
              e.stopPropagation()
              handleDismiss()
            }}
            className="ml-0.5 rounded-sm hover:bg-primary/20 transition-colors cursor-pointer"
          >
            <X className="size-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isRestorable
          ? 'Click to restore upgrade dialog'
          : (progress?.message ?? `Updating ${cliName} in background`)}
      </TooltipContent>
    </Tooltip>
  )
}
