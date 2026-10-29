import { useId, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, Lock, Minus, ShieldCheck } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  secretDeclinedMessage,
  secretRetentionText,
  secretSavedMessage,
  type SavedSecret,
  type SecretRequest,
  type SecretRetention,
} from './secret-request'

const RETENTION_OPTIONS: { value: SecretRetention; label: string }[] = [
  { value: 'forever', label: 'Until I forget it' },
  { value: 'day', label: '24 hours' },
]

const TOGGLE_ITEM_CLASS =
  'flex-none rounded-sm px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm'

/**
 * Card for a Jean MCP `request_secret` call. The value goes only to
 * `save_secret_request`, which writes an owner-only file; the chat gets the
 * file path as the next user message. The value stays in local state only.
 * The file belongs to this tool call, so the card can show it and forget it.
 */
export function SecretRequestCard({
  sessionId,
  toolCallId,
  request,
  answered,
  disabled,
  onSend,
}: {
  sessionId: string
  toolCallId: string
  request: SecretRequest
  /** A user message already follows the request */
  answered: boolean
  disabled: boolean
  onSend: ((text: string) => void) | undefined
}) {
  const inputId = useId()
  const queryClient = useQueryClient()
  const queryKey = ['secret-request', sessionId, toolCallId]
  const { data: saved } = useQuery({
    queryKey,
    queryFn: () =>
      invoke<SavedSecret | null>('secret_request_status', {
        sessionId,
        toolCallId,
      }),
  })
  const [secret, setSecret] = useState('')
  const [retention, setRetention] = useState<SecretRetention>('forever')
  const [submitting, setSubmitting] = useState(false)
  const [declined, setDeclined] = useState(false)
  // Enter and click can both submit before a render
  const inFlight = useRef(false)

  const forget = async () => {
    try {
      await invoke('forget_secret_request', { sessionId, toolCallId })
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, null)
      toast.success(`Forgot "${request.label}"`)
    } catch (error) {
      toast.error(`Could not forget the secret: ${String(error)}`)
    }
  }

  if (saved) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <CheckIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {request.label} · saved, {secretRetentionText(saved.retention)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => void forget()}
        >
          Forget
        </Button>
      </div>
    )
  }

  if (answered || declined) {
    const Icon = declined ? Minus : Lock
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {request.label} · {declined ? 'declined' : 'not saved'}
        </span>
      </div>
    )
  }

  const blocked = disabled || submitting || !onSend

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (blocked || inFlight.current || !secret.trim()) return
    inFlight.current = true
    setSubmitting(true)
    try {
      const result = await invoke<SavedSecret>('save_secret_request', {
        sessionId,
        toolCallId,
        label: request.label,
        secret,
        retention,
      })
      setSecret('')
      // A status fetch started before the save would overwrite the result
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, result)
      onSend(secretSavedMessage(request.label, result))
    } catch (error) {
      toast.error(`Could not save the secret: ${String(error)}`)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const decline = () => {
    if (blocked) return
    setSecret('')
    setDeclined(true)
    onSend(secretDeclinedMessage(request.label))
  }

  return (
    <form
      className="my-2 flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={save}
      autoComplete="off"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          {request.label}
        </label>
        {request.reason && (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {request.reason}
          </p>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={inputId}
          // A password field makes browsers offer to save a login
          type="text"
          className="min-w-0 flex-1 [-webkit-text-security:disc]"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          placeholder={request.placeholder ?? 'Paste the secret'}
          value={secret}
          disabled={blocked}
          onChange={event => setSecret(event.currentTarget.value)}
        />
        <Button type="submit" disabled={blocked || !secret.trim()}>
          Save securely
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Keep</span>
        <ToggleGroup
          type="single"
          value={retention}
          onValueChange={value => {
            if (value) setRetention(value as SecretRetention)
          }}
          aria-label="Keep the secret"
          size="sm"
          disabled={blocked}
          className="gap-0.5 rounded-md bg-muted p-0.5"
        >
          {RETENTION_OPTIONS.map(option => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className={TOGGLE_ITEM_CLASS}
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
          Kept out of chat, in a private file this agent&apos;s commands can
          read. You can forget it at any time.
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={blocked}
          onClick={decline}
        >
          Decline
        </Button>
      </div>
    </form>
  )
}
