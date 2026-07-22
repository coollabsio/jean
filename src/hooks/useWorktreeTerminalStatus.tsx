import { useMemo } from 'react'
import { Terminal } from 'lucide-react'
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
  const activeTerminalCount = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.filter(
      t => isPanelTerminal(t) && state.runningTerminals.has(t.id)
    ).length
  })
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
  const failedTerminalCount = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.filter(
      t => isPanelTerminal(t) && !!t.command && state.failedTerminals.has(t.id)
    ).length
  })
  const hasActiveTerminal = activeTerminalCount > 0
  const showTerminalIndicator = hasActiveTerminal || hasFailedTerminal

  // Poll while any PTY is active so manually started dev servers can also
  // surface their listening ports in the worktree tooltip.
  const { data: listeningPorts = [] } =
    useTerminalListeningPorts(hasActiveTerminal)

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
      if (runningTerminals.has(t.id)) {
        const ports = (listeningPorts as TerminalPortInfo[])
          .filter(p => p.terminalId === t.id)
          .map(p => `:${p.port}`)
        const portSuffix = ports.length > 0 ? ` (${ports.join(', ')})` : ''
        lines.push(`${t.command ?? t.label}${portSuffix}`)
      } else if (t.command && failedTerminals.has(t.id)) {
        lines.push(`${t.command} (crashed)`)
      }
    }
    return lines
  }, [
    showTerminalIndicator,
    worktreeId,
    listeningPorts,
    activeTerminalCount,
    failedTerminalCount,
  ])

  return {
    hasActiveTerminal,
    activeTerminalCount,
    hasRunningTerminal,
    hasFailedTerminal,
    failedTerminalCount,
    showTerminalIndicator,
    tooltipLines,
  }
}

/**
 * Compact worktree-level terminal status for the sidebar and canvas.
 * Green: active shell. Amber: active known script. Red: failed script.
 */
export function TerminalStatusIndicator({
  worktreeId,
  iconSize = 'h-2.5 w-2.5',
  variant = 'compact',
}: {
  worktreeId: string
  iconSize?: string
  variant?: 'compact' | 'summary'
}) {
  const {
    activeTerminalCount,
    hasRunningTerminal,
    hasFailedTerminal,
    failedTerminalCount,
    showTerminalIndicator,
    tooltipLines,
  } = useWorktreeTerminalStatus(worktreeId)

  if (!showTerminalIndicator || !tooltipLines) return null

  const statusColor = hasFailedTerminal
    ? 'text-red-500'
    : hasRunningTerminal
      ? 'text-amber-500 dark:text-yellow-400'
      : 'text-emerald-500'
  const ariaLabel =
    activeTerminalCount > 0
      ? `${activeTerminalCount} active terminal${activeTerminalCount === 1 ? '' : 's'}${failedTerminalCount > 0 ? `, ${failedTerminalCount} failed` : ''}`
      : `${failedTerminalCount} failed terminal${failedTerminalCount === 1 ? '' : 's'}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center text-muted-foreground',
            variant === 'summary' ? 'gap-1 rounded px-2 py-0.5' : 'h-4 gap-0.5'
          )}
          aria-label={ariaLabel}
        >
          <Terminal className={cn('shrink-0', iconSize, statusColor)} />
          {variant === 'summary' ? (
            <span>
              {activeTerminalCount > 0
                ? `${activeTerminalCount} terminal${activeTerminalCount === 1 ? '' : 's'} running${failedTerminalCount > 0 ? ` · ${failedTerminalCount} failed` : ''}`
                : `${failedTerminalCount} terminal${failedTerminalCount === 1 ? '' : 's'} failed`}
            </span>
          ) : (
            activeTerminalCount > 1 && (
              <span className="text-[9px] leading-none tabular-nums">
                {activeTerminalCount}
              </span>
            )
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          {tooltipLines.map((line, i) => (
            <span key={i} className="text-xs">
              {line}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
