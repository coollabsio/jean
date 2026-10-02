import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { chatQueryKeys, useSession } from '@/services/chat'
import type { Session } from '@/types/chat'

/** Location belongs to the session, not to a global CLI preference. */
export function DevinLocationPicker({
  sessionId,
  worktreeId,
  worktreePath,
  isSending,
}: {
  sessionId: string | null
  worktreeId: string | null
  worktreePath: string | null
  isSending: boolean
}) {
  const { data: session } = useSession(sessionId, worktreeId, worktreePath)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (location: 'local' | 'cloud') => {
      await invoke('set_session_devin_location', {
        sessionId,
        worktreeId,
        worktreePath,
        location,
      })
      return { location, sessionId, worktreeId }
    },
    onSuccess: ({ location, sessionId, worktreeId }) => {
      if (!sessionId) return
      queryClient.setQueryData<Session | null>(
        chatQueryKeys.session(sessionId),
        current =>
          current
            ? {
                ...current,
                devin_location: location,
                devin_config_options: null,
                devin_config_overrides: {},
              }
            : current
      )
      if (worktreeId) {
        void queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(worktreeId),
        })
      }
    },
    onError: error =>
      toast.error(`Failed to set Devin location: ${String(error)}`),
  })
  const configMutation = useMutation({
    mutationFn: async ({
      configId,
      value,
    }: {
      configId: string
      value: string
    }) => {
      await invoke('set_session_devin_config', {
        sessionId,
        worktreeId,
        worktreePath,
        configId,
        value,
      })
      return { sessionId, configId, value }
    },
    onSuccess: ({ sessionId, configId, value }) => {
      if (!sessionId) return
      queryClient.setQueryData<Session | null>(
        chatQueryKeys.session(sessionId),
        current =>
          current
            ? {
                ...current,
                devin_config_overrides: {
                  ...current.devin_config_overrides,
                  [configId]: value,
                },
              }
            : current
      )
    },
    onError: error =>
      toast.error(`Failed to set Devin configuration: ${String(error)}`),
  })
  const location = session?.devin_location ?? 'local'
  const controls =
    session?.devin_config_options?.filter(
      option =>
        option.type === 'select' &&
        (['thought_level', 'speed'].includes(option.category ?? option.id) ||
          (location === 'cloud' && option.category === 'model'))
    ) ?? []
  const locked =
    !session ||
    isSending ||
    mutation.isPending ||
    !!session.devin_session_id ||
    (session.message_count ?? 0) > 0 ||
    session.messages.length > 0

  return (
    <>
      <label
        className="inline-flex shrink-0 items-center gap-1 px-2 text-xs"
        title={
          location === 'cloud'
            ? 'Runs on Devin Cloud. Local files and local MCP servers are not available. Start a new session to change location after chat starts.'
            : 'Runs in this local worktree. Start a new session to change location after chat starts.'
        }
      >
        <span>Devin</span>
        <select
          aria-label="Devin session location"
          value={location}
          disabled={locked}
          onChange={event =>
            mutation.mutate(event.target.value as 'local' | 'cloud')
          }
          className="rounded border bg-background px-1 py-1 disabled:opacity-70"
        >
          <option value="local">Local</option>
          <option value="cloud">Cloud · remote files</option>
        </select>
      </label>
      {location === 'cloud' && (
        <span className="px-2 text-xs text-muted-foreground">
          Cloud permissions are managed by Devin. Plan is a task instruction,
          not a read-only guarantee.
        </span>
      )}
      {controls.map(control => (
        <label
          key={control.id}
          className="inline-flex shrink-0 items-center gap-1 px-2 text-xs"
        >
          <span>{control.name}</span>
          <select
            aria-label={`Devin ${control.name}`}
            value={
              session?.devin_config_overrides?.[control.id] ??
              control.currentValue
            }
            disabled={isSending || configMutation.isPending}
            onChange={event =>
              configMutation.mutate({
                configId: control.id,
                value: event.target.value,
              })
            }
            className="rounded border bg-background px-1 py-1 disabled:opacity-70"
          >
            {control.options
              .flatMap(option =>
                'options' in option ? option.options : [option]
              )
              .map(option => (
                <option key={option.value} value={option.value}>
                  {option.name}
                </option>
              ))}
          </select>
        </label>
      ))}
    </>
  )
}
