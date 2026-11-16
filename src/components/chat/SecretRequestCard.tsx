import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  Eye,
  EyeOff,
  Lock,
  Minus,
  ShieldCheck,
} from '@/components/icons/reicon'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  combinedSecretAnswers,
  secretDeclinedMessage,
  secretRetentionText,
  secretSavedMessage,
  type SavedSecret,
  type SecretRequest,
  type SecretRetention,
} from './secret-request'

const RETENTION_OPTIONS: { value: SecretRetention; label: string }[] = [
  { value: 'forever', label: 'Until I delete it' },
  { value: 'day', label: '24 hours' },
]

const TOGGLE_ITEM_CLASS =
  'flex-none rounded-sm px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm'

/**
 * All secret requests of one assistant message. Each card saves its own value,
 * but the chat gets one message only after every card is saved or declined:
 * a message per card would end the request for the other cards.
 */
export function SecretRequestGroup({
  sessionId,
  requests,
  answered,
  disabled,
  onSend,
}: {
  sessionId: string
  requests: { id: string; request: SecretRequest }[]
  answered: boolean
  disabled: boolean
  onSend: ((text: string) => void) | undefined
}) {
  const [answers, setAnswers] = useState<Partial<Record<string, string>>>({})
  const sent = useRef(false)
  const ids = requests.map(({ id }) => id)
  const message = combinedSecretAnswers(ids, answers)

  useEffect(() => {
    if (!message || answered || sent.current || !onSend) return
    sent.current = true
    onSend(message)
  }, [message, answered, onSend])

  const resolve = useCallback((id: string, text: string | null) => {
    setAnswers(current => {
      if (text === null) {
        if (!(id in current)) return current
        const { [id]: _removed, ...rest } = current
        return rest
      }
      return current[id] === text ? current : { ...current, [id]: text }
    })
  }, [])

  const open = requests.length - Object.keys(answers).length
  const waiting =
    !answered && requests.length > 1 && open > 0 && open < requests.length

  return (
    <>
      {requests.map(({ id, request }) => (
        <SecretRequestCard
          key={id}
          sessionId={sessionId}
          toolCallId={id}
          request={request}
          answered={answered}
          disabled={disabled || !onSend}
          onResolve={resolve}
        />
      ))}
      {waiting && (
        <p className="text-xs text-muted-foreground">
          Jean sends your answers when all {requests.length} requests are saved
          or declined. {open} left.
        </p>
      )}
    </>
  )
}

/**
 * Card for a Jean MCP `request_secret` call. The value goes only to
 * `save_secret_request`, which writes an owner-only file; the group sends the
 * file path to the chat as the next user message. The value stays in local state only.
 * The file belongs to this tool call, so the card can show it and delete it.
 */
export function SecretRequestCard({
  sessionId,
  toolCallId,
  request,
  answered,
  disabled,
  onResolve,
}: {
  sessionId: string
  toolCallId: string
  request: SecretRequest
  /** A user message already follows the request */
  answered: boolean
  disabled: boolean
  /** The answer for the chat, or null when the user deleted the saved value */
  onResolve: (toolCallId: string, text: string | null) => void
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
  const [revealed, setRevealed] = useState(false)
  // Enter and click can both submit before a render
  const inFlight = useRef(false)

  // Also covers a value saved before a reload
  useEffect(() => {
    if (saved && !answered) {
      onResolve(toolCallId, secretSavedMessage(request.label, saved))
    }
  }, [saved, answered, onResolve, toolCallId, request.label])

  const forget = async () => {
    try {
      await invoke('forget_secret_request', { sessionId, toolCallId })
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, null)
      onResolve(toolCallId, null)
      toast.success(`Deleted "${request.label}"`)
    } catch (error) {
      toast.error(`Could not delete the secret: ${String(error)}`)
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
          Delete
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

  const blocked = disabled || submitting

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
    onResolve(toolCallId, secretDeclinedMessage(request.label))
  }

  const masked = revealed ? '' : '[-webkit-text-security:disc]'
  const revealButton = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-8 shrink-0"
      aria-label={revealed ? 'Hide the value' : 'Show the value'}
      aria-pressed={revealed}
      aria-controls={inputId}
      onClick={() => setRevealed(value => !value)}
    >
      {revealed ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
    </Button>
  )

  const fieldProps = {
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: false,
    'data-1p-ignore': true,
    'data-lpignore': 'true',
    'data-bwignore': true,
    placeholder:
      request.placeholder ??
      (request.multiline ? 'Paste the contents' : 'Paste the secret'),
    value: secret,
    disabled: blocked,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setSecret(event.currentTarget.value),
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
      {request.example && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Example</span>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {request.example}
          </pre>
        </div>
      )}
      <div
        className={
          request.multiline
            ? 'flex min-w-0 flex-col items-end gap-2'
            : 'flex min-w-0 items-center gap-2'
        }
      >
        {request.multiline ? (
          <Textarea
            id={inputId}
            className={`max-h-64 min-h-28 w-full font-mono text-xs ${masked}`}
            {...fieldProps}
          />
        ) : (
          <Input
            id={inputId}
            // A password field makes browsers offer to save a login
            type="text"
            className={`min-w-0 flex-1 ${masked}`}
            {...fieldProps}
          />
        )}
        <div className="flex shrink-0 items-center gap-1">
          {revealButton}
          <Button type="submit" disabled={blocked || !secret.trim()}>
            Save securely
          </Button>
        </div>
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
          read. Delete it anytime, just ask in any chat.
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
