import { useState } from 'react'
import { ChevronRight, RefreshCw } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface InlineErrorProps {
  /** One short sentence. */
  message: string
  /** Full output (install log, stderr). Hidden until "Show log". */
  details?: string | null
  onRetry?: () => void
  className?: string
}

/** Onboarding error: short message, Retry, and the log hidden by default. */
export function InlineError({
  message,
  details,
  onRetry,
  className,
}: InlineErrorProps) {
  const [showLog, setShowLog] = useState(false)
  const hasDetails = !!details?.trim() && details.trim() !== message

  return (
    <div
      role="alert"
      className={cn(
        'space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3',
        className
      )}
    >
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm text-destructive">{message}</p>
        {onRetry && (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-1.5 size-3.5" />
            Retry
          </Button>
        )}
      </div>
      {hasDetails && (
        <>
          <button
            type="button"
            onClick={() => setShowLog(value => !value)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform',
                showLog && 'rotate-90'
              )}
            />
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
              {details}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

/** First line of an error, for the short message. */
export function errorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (
    text
      .split('\n')
      .find(line => line.trim())
      ?.trim() ?? text
  )
}
