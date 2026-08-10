import { useState } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronRight, Check, CircleAlert, Terminal, X } from 'lucide-react'
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

  const title = result.success ? 'Workspace ready' : 'Workspace setup failed'
  const description = result.success
    ? 'Project setup completed successfully.'
    : 'The conversation can continue, but the workspace may be incomplete.'

  return (
    <Collapsible
      className="mx-auto my-5 w-full max-w-3xl"
      open={isExpanded}
      onOpenChange={setIsExpanded}
    >
      <div
        className={cn(
          'flex items-start gap-3 rounded-2xl rounded-tl-md border bg-card px-4 py-3 shadow-sm',
          result.success
            ? 'border-border'
            : 'border-destructive/30 bg-destructive/5'
        )}
      >
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            result.success
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : 'bg-destructive/10 text-destructive'
          )}
        >
          {result.success ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <CircleAlert className="h-4 w-4" aria-hidden="true" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            </div>
            {!result.success && (
              <button
                type="button"
                onClick={onDismiss}
                className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <CollapsibleTrigger className="mt-3 flex items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                isExpanded && 'rotate-90'
              )}
              aria-hidden="true"
            />
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            {isExpanded ? 'Hide setup details' : 'Show setup details'}
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="mt-2 rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
              <p className="break-all text-muted-foreground">
                <span className="opacity-60">workdir:</span>{' '}
                {result.worktreePath}
              </p>
              {result.script && (
                <p className="mt-1 break-all text-muted-foreground">
                  <span className="opacity-60">script:</span> {result.script}
                </p>
              )}
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words text-foreground/80">
                {result.output || '(no output)'}
              </pre>
            </div>
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  )
}
