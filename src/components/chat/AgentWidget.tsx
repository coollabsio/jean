import { memo, useCallback, useState } from 'react'
import { ChevronRight, Users, X } from '@/components/icons/reicon'
import type { SubAgent } from '@/types/chat'
import { cn } from '@/lib/utils'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { TaskCallDetails } from './ToolCallInline'
import { formatSubagentModel } from './hooks/useActiveTodosAndAgents'
import { formatTokens } from '@/lib/session-debug'
import { useIsMobile } from '@/hooks/use-mobile'
import { useVisibilityAwareTicker } from '@/hooks/useVisibilityAwareTicker'

interface AgentWidgetProps {
  agents: SubAgent[]
  className?: string
  /** Callback to dismiss the widget */
  onClose?: () => void
  /** Whether the panel is expanded (default: false) */
  open?: boolean
  /** Callback when the panel is expanded or collapsed */
  onOpenChange?: (open: boolean) => void
  /** Callback when a file path in a tool call is clicked */
  onFileClick?: (filePath: string) => void
}

/**
 * Client-side run timings keyed by agent id. Module scope so the timings
 * survive remounts (session switch, layout change). Agents first seen after
 * they finished (e.g. restored history) have no timing.
 */
const agentTimings = new Map<string, { start: number; end?: number }>()

function trackTiming(agent: SubAgent) {
  const now = Date.now()
  const timing = agentTimings.get(agent.id)
  if (agent.status === 'in_progress') {
    if (!timing) agentTimings.set(agent.id, { start: now })
  } else if (timing && timing.end === undefined) {
    timing.end = now
  }
}

export function formatAgentElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Collapsible "Subagents" panel shown above the chat input.
 * Lists Claude Task/Agent and Codex multi-agent runs with live status.
 */
export function AgentWidget({
  agents,
  className,
  onClose,
  open = false,
  onOpenChange,
  onFileClick,
}: AgentWidgetProps) {
  const runningCount = agents.filter(a => a.status === 'in_progress').length
  const completedCount = agents.filter(a => a.status === 'completed').length

  for (const agent of agents) trackTiming(agent)

  // Running agents first, finished ones below; keep start order in each group
  const sortedAgents = [
    ...agents.filter(a => a.status === 'in_progress'),
    ...agents.filter(a => a.status !== 'in_progress'),
  ]

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <div className="overflow-hidden border-t border-border bg-card sm:rounded-lg sm:border">
        <div className="flex items-center text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex flex-1 min-w-0 items-center gap-2 select-none text-left cursor-pointer px-3 py-1.5 hover:bg-muted/50">
            <Users className="h-4 w-4 shrink-0" />
            <span className="font-medium">Subagents</span>
            {/* Collapsed panels hide the rows, so show their running state here */}
            {!open && runningCount > 0 && <WorkingWaveform />}
            <span className="rounded bg-muted/50 px-1.5 py-0.5 text-xs">
              {runningCount > 0
                ? `${runningCount} running`
                : `${completedCount}/${agents.length} done`}
            </span>
          </CollapsibleTrigger>
          {/* Only finished panels can be dismissed; running ones keep live status */}
          {onClose && runningCount === 0 && (
            <button
              type="button"
              onClick={onClose}
              className="mx-2 p-0.5 rounded hover:bg-muted transition-colors"
              aria-label="Dismiss subagents"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <CollapsibleContent>
          <ul className="max-h-[50vh] overflow-y-auto px-3 pb-2 space-y-1.5">
            {sortedAgents.map(agent => (
              <AgentItem
                key={agent.id}
                agent={agent}
                onFileClick={onFileClick}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

/**
 * Tool count, tokens, and elapsed time. Ticks on its own so the per-second
 * update does not re-render the row and its expanded tool calls. Mobile shows
 * only the bare token number and time so the model label stays visible.
 */
function AgentMeta({ agent, compact }: { agent: SubAgent; compact: boolean }) {
  const isDone = agent.status !== 'in_progress'
  const [now, setNow] = useState(() => Date.now())
  const updateNow = useCallback(() => setNow(Date.now()), [])
  useVisibilityAwareTicker(!isDone, updateNow)

  const timing = agentTimings.get(agent.id)
  const clientMs = timing ? (timing.end ?? now) - timing.start : undefined
  // CLI-reported time is exact once done; while running it only updates on
  // progress events, so the local ticking timer can be ahead of it.
  const elapsedMs = isDone
    ? (agent.durationMs ?? clientMs)
    : Math.max(clientMs ?? 0, agent.durationMs ?? 0) || undefined
  const meta = [
    agent.model ? formatSubagentModel(agent.model) : null,
    !compact && agent.toolCount
      ? `${agent.toolCount} tool${agent.toolCount === 1 ? '' : 's'}`
      : null,
    agent.tokens
      ? `${formatTokens(agent.tokens)}${compact ? '' : ' tokens'}`
      : null,
    elapsedMs !== undefined ? formatAgentElapsed(elapsedMs) : null,
  ].filter(Boolean)

  return (
    <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted-foreground empty:pl-0">
      {meta.length > 0 ? meta.join(' • ') : null}
    </span>
  )
}

interface AgentItemProps {
  agent: SubAgent
  onFileClick?: (filePath: string) => void
}

const AgentItem = memo(function AgentItem({
  agent,
  onFileClick,
}: AgentItemProps) {
  const [isOpen, setIsOpen] = useState(false)
  const isMobile = useIsMobile()
  const isDone = agent.status !== 'in_progress'

  return (
    <li className="min-w-0 text-xs">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-2 rounded text-left hover:bg-muted/50"
          title={agent.message}
        >
          <span
            className="flex w-2.5 shrink-0 justify-center"
            aria-label={agent.status.replace('_', ' ')}
          >
            {agent.status === 'in_progress' ? (
              <WorkingWaveform />
            ) : (
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  agent.status === 'completed' && 'bg-success',
                  agent.status === 'errored' && 'bg-warning',
                  agent.status === 'interrupted' && 'bg-muted-foreground/60'
                )}
              />
            )}
          </span>
          <span
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              isDone && 'text-muted-foreground/70'
            )}
          >
            {agent.label && (
              <>
                <span
                  className={cn(
                    'shrink-0 font-semibold',
                    isMobile && 'max-w-24 truncate'
                  )}
                >
                  {agent.label}
                </span>
                {agent.prompt ? (
                  <span className="shrink-0 text-muted-foreground/60">›</span>
                ) : null}
              </>
            )}
            <span className="truncate text-muted-foreground">
              {agent.prompt}
              {agent.status === 'interrupted' && (
                <span className="ml-1 text-[10px] uppercase tracking-wide">
                  Interrupted
                </span>
              )}
            </span>
          </span>
          <AgentMeta agent={agent} compact={isMobile} />
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200',
              isOpen && 'rotate-90'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <TaskCallDetails
            className="mt-1.5 mb-1 ml-3.5 rounded-md border border-border/50 bg-muted/30 px-3 py-2"
            prompt={agent.fullPrompt}
            report={agent.report ?? agent.message}
            subToolCalls={agent.toolCalls ?? []}
            allToolCalls={agent.allToolCalls}
            onFileClick={onFileClick}
            isStreaming={agent.status === 'in_progress'}
            isIncomplete={agent.status === 'in_progress'}
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
})
