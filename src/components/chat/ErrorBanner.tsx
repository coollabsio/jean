import { memo } from 'react'
import { AlertCircle, X } from 'lucide-react'

interface ErrorBannerProps {
  /** The error message to display */
  error: string
  /** Callback when user dismisses the error */
  onDismiss: () => void
}

/**
 * Error banner displayed when a chat request fails
 * Memoized to prevent re-renders when parent state changes
 */
export const ErrorBanner = memo(function ErrorBanner({
  error,
  onDismiss,
}: ErrorBannerProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 pb-2 md:px-6">
      <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Request failed</p>
          <p className="mt-1 select-text whitespace-pre-wrap break-words text-destructive/80">
            {error}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 hover:bg-destructive/20"
          aria-label="Dismiss error"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
})
