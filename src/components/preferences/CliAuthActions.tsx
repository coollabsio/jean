import type React from 'react'
import { Loader2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'

/** Sign-in state and action shown in the header of a backend's CLI section. */
export function CliAuthActions({
  installed,
  checking,
  authenticated,
  onSignIn,
  onSignInAgain,
  extra,
}: {
  installed: boolean
  checking: boolean
  authenticated: boolean
  onSignIn: () => void
  onSignInAgain?: () => void
  /** Extra action shown next to the sign-in state when the CLI is installed. */
  extra?: React.ReactNode
}) {
  if (!installed) {
    return <span className="text-sm text-muted-foreground">Not installed</span>
  }
  if (checking) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Checking...
      </span>
    )
  }
  if (authenticated) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {extra}
        Signed in
        {onSignInAgain && (
          <Button variant="outline" size="sm" onClick={onSignInAgain}>
            Sign in again
          </Button>
        )}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2">
      {extra}
      <Button variant="outline" size="sm" onClick={onSignIn}>
        Sign in
      </Button>
    </span>
  )
}

/** Explains a failed auth check under the CLI section, with a retry for timeouts. */
export function CliAuthProblem({
  timedOut,
  error,
  retrying,
  onRetry,
  manualCommand,
}: {
  timedOut: boolean
  error?: string | null
  retrying: boolean
  onRetry: () => void
  manualCommand: string
}) {
  if (timedOut) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Auth check timed out. Try again or run <code>{manualCommand}</code>{' '}
        manually.
        <Button
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    )
  }
  if (!error) return null
  return (
    <p className="text-xs text-muted-foreground">Not authenticated · {error}</p>
  )
}
