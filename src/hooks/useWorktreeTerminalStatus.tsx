import { useMemo } from 'react'
import { Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isPanelTerminal, useTerminalStore } from '@/store/terminal-store'
import { useTerminalListeningPorts } from '@/services/projects'
import type { TerminalPortInfo } from '@/services/projects'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Shared hook for per-worktree terminal status detection.
 * Tracks running/failed run-script terminals and discovered listening ports.
 */
export function useWorktreeTerminalStatus(worktreeId: string) {
  const hasRunningTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && !!t.command && state.runningTerminals.has(t.id)
    )
  })
  const hasFailedTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && !!t.command && state.failedTerminals.has(t.id)
    )
  })
  const showTerminalIndicator = hasRunningTerminal || hasFailedTerminal

  // Poll for listening ports only when terminals are running
  const { data: listeningPorts = [] } =
    useTerminalListeningPorts(hasRunningTerminal)

  // Build tooltip lines on demand via getState() — no subscription needed
  // for tooltip content (stale-by-one-render is fine for hover-only UI)
  const tooltipLines = useMemo(() => {
    if (!showTerminalIndicator) return null
    const { terminals, runningTerminals, failedTerminals } =
      useTerminalStore.getState()
    const worktreeTerminals = terminals[worktreeId] ?? []
    const lines: string[] = []
    for (const t of worktreeTerminals) {
      if (!isPanelTerminal(t)) continue
      if (!t.command) continue
      if (runningTerminals.has(t.id)) {
        const ports = (listeningPorts as TerminalPortInfo[]).flatMap(p =>
          p.terminalId === t.id ? [`:${p.port}`] : []
        )
        const portSuffix = ports.length > 0 ? ` (${ports.join(', ')})` : ''
        lines.push(`${t.command}${portSuffix}`)
      } else if (failedTerminals.has(t.id)) {
        lines.push(`${t.command} (crashed)`)
      }
    }
    return lines
  }, [showTerminalIndicator, worktreeId, listeningPorts])

  return {
    hasRunningTerminal,
    hasFailedTerminal,
    showTerminalIndicator,
    tooltipLines,
  }
}

/**
 * Terminal status indicator with tooltip showing running/failed status and listening ports.
 * Running: yellow square-spinner (original style). Failed: red square.
 * Returns null when no run-script terminals are active or failed.
 */
export function TerminalStatusIndicator({
  worktreeId,
  iconSize = 'h-2.5 w-2.5',
}: {
  worktreeId: string
  iconSize?: string
}) {
  const { hasFailedTerminal, showTerminalIndicator, tooltipLines } =
    useWorktreeTerminalStatus(worktreeId)

  if (!showTerminalIndicator || !tooltipLines) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Play
          className={cn(
            'shrink-0 fill-none',
            iconSize,
            hasFailedTerminal
              ? 'text-red-500'
              : 'text-amber-500 dark:text-yellow-400 animate-icon-glow'
          )}
        />
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          {tooltipLines.map(line => (
            <span key={line} className="text-xs">
              {line}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
