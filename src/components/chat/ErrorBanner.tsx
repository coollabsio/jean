import { memo, type ReactNode } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { openExternal } from '@/lib/platform'

interface ErrorBannerProps {
  /** The error message to display */
  error: string
  /** Callback when user dismisses the error */
  onDismiss: () => void
}

const URL_REGEX = /(https?:\/\/[^\s<>"'`)]+[^\s<>"'`).,;:!?])/g

function renderWithLinks(text: string): ReactNode {
  const segments = text.split(URL_REGEX)
  const seen = new Map<string, number>()
  return segments.map(segment => {
    const isUrl = /^https?:\/\//.test(segment)
    const baseKey = isUrl ? `url:${segment}` : `text:${segment}`
    const n = seen.get(baseKey) ?? 0
    seen.set(baseKey, n + 1)
    const key = n === 0 ? baseKey : `${baseKey}#${n}`

    if (isUrl) {
      return (
        <button
          key={key}
          type="button"
          onClick={() => openExternal(segment)}
          className="break-all underline underline-offset-2 hover:text-destructive"
        >
          {segment}
        </button>
      )
    }
    return <span key={key}>{segment}</span>
  })
}

/**
 * Error banner displayed when a chat request fails
 * Memoized to prevent re-renders when parent state changes
 */
export const ErrorBanner = memo(function ErrorBanner({
  error,
  onDismiss,
}: ErrorBannerProps) {
  const lower = error.toLowerCase()
  const isCredits =
    lower.includes('insufficient balance') || lower.includes('creditserror')
  const title = isCredits ? 'Out of credits' : 'Request failed'

  return (
    <div className="mx-auto max-w-7xl px-4 pb-2 md:px-6">
      <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-1 select-text whitespace-pre-wrap break-words text-destructive/80">
            {renderWithLinks(error)}
          </p>
          {isCredits && (
            <p className="mt-1 text-xs text-destructive/70">
              Top up your OpenCode workspace, or switch to a different
              provider/model in the toolbar.
            </p>
          )}
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
