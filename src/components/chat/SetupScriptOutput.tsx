import { useState } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  X,
} from '@/components/icons/reicon'
import { cn } from '@/lib/utils'
import type { SetupScriptResult } from '@/types/chat'

interface SetupScriptOutputProps {
  /** Setup script result to display */
  result: SetupScriptResult
  /** Callback when user dismisses the output */
  onDismiss: () => void
}

/**
 * Renders the output from a jean.json setup script in a collapsible format
 */
export function SetupScriptOutput({
  result,
  onDismiss,
}: SetupScriptOutputProps) {
  // Collapsed by default on success, expanded on failure
  const [isExpanded, setIsExpanded] = useState(!result.success)

  const StatusIcon = result.success ? CheckCircle2 : XCircle
  const statusColor = result.success ? 'text-success' : 'text-destructive'
  const statusText = result.success
    ? `Setup script completed for ${result.worktreeName}`
    : `Setup script failed for ${result.worktreeName}`

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'group my-1 min-w-0 rounded-md text-xs',
          // Success is a quiet status line; only failures get a tinted box
          !result.success && 'bg-destructive/10'
        )}
      >
        <div className="flex min-w-0 items-center">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-muted/30">
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform duration-200',
                isExpanded && 'rotate-90'
              )}
            />
            <StatusIcon className={cn('size-3.5 shrink-0', statusColor)} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {statusText}
            </span>
          </CollapsibleTrigger>
          <button
            type="button"
            onClick={onDismiss}
            className="mr-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            aria-label="Dismiss setup script status"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <CollapsibleContent>
          <div className="mt-1 ml-5 rounded-md bg-muted/20 px-3 py-2">
            <div className="mb-2 text-xs text-muted-foreground">
              <span className="opacity-60">workdir:</span> {result.worktreePath}
            </div>
            {result.script && (
              <div className="mb-2 text-xs text-muted-foreground">
                <span className="opacity-60">script:</span>{' '}
                <code className="rounded bg-muted px-1 py-0.5">
                  {result.script}
                </code>
              </div>
            )}
            <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
              {result.output || '(no output)'}
            </pre>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
