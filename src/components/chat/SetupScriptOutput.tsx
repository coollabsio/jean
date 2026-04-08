import { useState } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronRight, CheckCircle2, XCircle, X } from 'lucide-react'
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
  const statusColor = result.success ? 'text-green-500' : 'text-destructive'
  const statusTitle = result.success ? 'Success' : 'Failed'
  const statusText = result.success
    ? `Setup script completed for ${result.worktreeName}`
    : `Setup script failed for ${result.worktreeName}`

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'my-2 rounded border font-mono text-sm',
          result.success
            ? 'border-muted bg-muted/30'
            : 'border-destructive/30 bg-destructive/10'
        )}
      >
        <div className="flex items-center">
          <CollapsibleTrigger className="flex flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                isExpanded && 'rotate-90'
              )}
            />
            <span title={statusTitle}><StatusIcon className={cn('h-4 w-4 shrink-0', statusColor)} /></span>
            <span className="truncate text-muted-foreground">{statusText}</span>
          </CollapsibleTrigger>
          {/* Only show dismiss button on failure - success messages should persist */}
          {!result.success && (
            <button
              onClick={onDismiss}
              className="mr-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <CollapsibleContent>
          <div className="border-t border-muted px-4 py-3 select-text cursor-text">
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
