import { useMemo } from 'react'
import { Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTerminalStore } from '@/store/terminal-store'
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
      t => !!t.command && state.runningTerminals.has(t.id)
    )
  })
  const hasFailedTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => !!t.command && state.failedTerminals.has(t.id)
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
      if (!t.command) continue
      if (runningTerminals.has(t.id)) {
        const ports = (listeningPorts as TerminalPortInfo[])
          .filter(p => p.terminalId === t.id)
          .map(p => `:${p.port}`)
        const portSuffix = ports.length > 0 ? ` (${ports.join(', ')})` : ''
        lines.push(`${t.command}${portSuffix}`)
      } else if (failedTerminals.has(t.id)) {
        lines.push(`${t.command} (crashed)`)
      }
    }
    return lines
  }, [showTerminalIndicator, worktreeId, listeningPorts])

  return { hasFailedTerminal, showTerminalIndicator, tooltipLines }
}

/**
 * Play icon with tooltip showing running/failed terminal status and listening ports.
 * Returns null when no run-script terminals are active or failed.
 */
export function TerminalStatusIndicator({
  worktreeId,
  iconSize = 'h-2.5 w-2.5',
  onClick,
}: {
  worktreeId: string
  iconSize?: string
  onClick?: (e: React.MouseEvent) => void
}) {
  const { hasFailedTerminal, showTerminalIndicator, tooltipLines } =
    useWorktreeTerminalStatus(worktreeId)

  if (!showTerminalIndicator || !tooltipLines) return null

  const handleClick = onClick
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        onClick(e)
      }
    : undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Play
          className={cn(
            'shrink-0 fill-current',
            iconSize,
            handleClick && 'cursor-pointer hover:opacity-80',
            hasFailedTerminal
              ? 'text-red-500'
              : 'text-yellow-400 animate-icon-glow'
          )}
          onClick={handleClick}
        />
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
