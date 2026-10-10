import { memo, useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, X } from '@/components/icons/reicon'
import { openExternal } from '@/lib/platform'
import { formatResetCountdown } from '@/lib/usage-format'

interface ErrorBannerProps {
  /** The error message to display */
  error: string
  /** Callback when user dismisses the error */
  onDismiss: () => void
  /**
   * When set, the error is a usage/rate limit on a backend that exposes a reset
   * time. Renders the "Auto-continue when limit resets" control.
   */
  onAutoContinue?: () => void
  /** Cancel an armed auto-continue. */
  onCancelAutoContinue?: () => void
  /** Whether auto-continue is currently armed for this session. */
  isAutoResumeArmed?: boolean
  /** Reset time (epoch ms) for the countdown; null when unknown. */
  limitResetAtMs?: number | null
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
  onAutoContinue,
  onCancelAutoContinue,
  isAutoResumeArmed = false,
  limitResetAtMs = null,
}: ErrorBannerProps) {
  const lower = error.toLowerCase()
  const isCredits =
    lower.includes('insufficient balance') || lower.includes('creditserror')
  const title = isCredits ? 'Out of credits' : 'Request failed'

  // Live-tick the countdown once a second while a reset time is shown.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!onAutoContinue || limitResetAtMs == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [onAutoContinue, limitResetAtMs])

  const countdown = (() => {
    if (limitResetAtMs == null) return null
    const diffMs = limitResetAtMs - now
    // Under a minute, show a real seconds countdown (not "<1m").
    if (diffMs > 0 && diffMs < 60_000) return `${Math.ceil(diffMs / 1000)}s`
    return formatResetCountdown(limitResetAtMs, now)
  })()

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
          {onAutoContinue &&
            (isAutoResumeArmed ? (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span className="text-destructive/80">
                  {countdown
                    ? `Auto-continuing in ${countdown}`
                    : 'Auto-continuing when limit resets'}
                </span>
                {onCancelAutoContinue && (
                  <button
                    type="button"
                    onClick={onCancelAutoContinue}
                    className="rounded border border-destructive/30 px-2 py-0.5 font-medium hover:bg-destructive/20"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onAutoContinue}
                className="mt-2 rounded border border-destructive/30 px-2 py-0.5 text-xs font-medium hover:bg-destructive/20"
              >
                {countdown
                  ? `Auto-continue when limit resets (in ${countdown})`
                  : 'Auto-continue when limit resets'}
              </button>
            ))}
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
