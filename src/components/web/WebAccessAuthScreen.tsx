import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { WsAuthReason } from '@/lib/transport'
import { webAccessServerLabel } from '@/lib/environment'

interface WebAccessAuthScreenProps {
  authError: string
  /** Why we are asking. Defaults to a first visit rather than a failure.
   * Whatever the reason, the form stays available: submitting a token
   * reloads the page, which is also how a lost connection recovers. */
  reason?: Exclude<WsAuthReason, 'unreachable'>
  onTokenSubmit: (token: string) => void
}

export function WebAccessAuthScreen({
  authError,
  reason = 'signed-out',
  onTokenSubmit,
}: WebAccessAuthScreenProps) {
  const [token, setToken] = useState('')
  const [emptyError, setEmptyError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // The refused-token message describes the previous submission; drop it as
  // soon as the user starts editing a replacement.
  const [edited, setEdited] = useState(false)

  const host = webAccessServerLabel()
  const fieldError = emptyError
    ? "Enter the access token from Jean's Web Access settings."
    : reason === 'rejected' && !edited
      ? authError
      : null

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) {
      setEmptyError(true)
      return
    }
    setEmptyError(false)
    // Submitting reloads the page (validation happens on the fresh load), so
    // never re-enable the button — the reload resets it.
    setSubmitting(true)
    onTokenSubmit(trimmed)
  }

  return (
    <div className="w-full max-w-sm px-6">
      <div className="flex flex-col items-center text-center">
        <img
          src="/logo.png"
          alt=""
          width={48}
          height={48}
          className="size-12 rounded-xl"
        />
        <h1 className="mt-5 text-xl font-semibold tracking-tight">
          Sign in to Jean
        </h1>
        {host && (
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">
            {host}
          </p>
        )}
      </div>

      <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="web-access-token">Access token</Label>
          <Input
            id="web-access-token"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={event => {
              setToken(event.target.value)
              if (emptyError) setEmptyError(false)
              if (!edited) setEdited(true)
            }}
            placeholder="Paste your Jean access token"
            aria-describedby={fieldError ? 'web-access-token-error' : undefined}
            aria-invalid={!!fieldError}
          />
          {fieldError && (
            <p
              id="web-access-token-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {fieldError}
            </p>
          )}
        </div>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-8 text-center text-xs text-muted-foreground">
        Find the token in Jean&apos;s Web Access settings.
      </p>
    </div>
  )
}
