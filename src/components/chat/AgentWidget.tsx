import { useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  ChevronRight,
  Users,
  XCircle,
  X,
} from 'lucide-react'
import type { CodexAgent } from '@/types/chat'
import { cn } from '@/lib/utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

interface AgentWidgetProps {
  agents: CodexAgent[]
  className?: string
  /** Whether the prompt execution is still in progress */
  isStreaming?: boolean
  /** Callback to dismiss the widget */
  onClose?: () => void
  /** Whether to start expanded (default: false) */
  defaultOpen?: boolean
}

/**
 * Collapsible widget displaying Codex multi-agent status
 * Mirrors TodoWidget pattern — shows agent lifecycle next to textarea
 */
export function AgentWidget({
  agents,
  className,
  isStreaming = false,
  onClose,
  defaultOpen = false,
}: AgentWidgetProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const completedCount = agents.filter(a => a.status === 'completed').length
  const totalCount = agents.length
  const allCompleted = completedCount === totalCount && totalCount > 0

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <div
        className={cn(
          'mt-1 rounded-md border border-border bg-sidebar',
          isOpen && 'bg-sidebar'
        )}
      >
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex flex-1 items-center gap-2 hover:bg-muted/50 cursor-pointer select-none -ml-3 -my-2 pl-3 py-2 rounded-l-md">
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
            {!isOpen &&
            !allCompleted &&
            (isStreaming || agents.some(a => a.status === 'in_progress')) ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Users className="h-4 w-4 shrink-0" />
            )}
            <span className="font-medium">Agents</span>
            <span
              className={cn(
                'rounded bg-muted/50 px-1.5 py-0.5 text-xs',
                allCompleted &&
                  'bg-green-500/20 text-green-600 dark:text-green-400'
              )}
            >
              {completedCount}/{totalCount}
            </span>
          </CollapsibleTrigger>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-0.5 rounded hover:bg-muted transition-colors"
              aria-label="Dismiss agents"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <CollapsibleContent>
          <div className="border-t border-border/50 px-3 py-2">
            <ul className="space-y-1">
              {agents.map(agent => (
                <AgentItem key={agent.id} agent={agent} />
              ))}
            </ul>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface AgentItemProps {
  agent: CodexAgent
}

function AgentItem({ agent }: AgentItemProps) {
  return (
    <li className="flex items-start gap-2 py-0.5 text-xs">
      <span className="mt-0.5 shrink-0">
        {agent.status === 'completed' ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : agent.status === 'errored' ? (
          <XCircle className="h-4 w-4 text-amber-500" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        )}
      </span>
      <span
        className={cn(
          'text-muted-foreground',
          agent.status === 'completed' &&
            'line-through text-muted-foreground/60',
          agent.status === 'errored' && 'text-muted-foreground/60'
        )}
      >
        {agent.prompt}
      </span>
    </li>
  )
}
