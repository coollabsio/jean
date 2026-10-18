import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { invoke, listen } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'

interface AcpPermissionRequest {
  request_id: string
  backend: 'grok' | 'kimi'
  title: string
  kind: string
  options: { optionId: string; name: string; kind: string }[]
}

/** Shared approval card for ACP agents; commands also work through Web Access. */
export function AcpPermissionsRequest({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient()
  const queryKey = ['acp-permissions', sessionId]
  const {
    data = [],
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () =>
      invoke<AcpPermissionRequest[]>('get_acp_permission_requests', {
        sessionId,
      }),
  })
  const request = data[0]
  const requestId = request?.request_id
  const response = useMutation({
    mutationFn: (optionId: string) =>
      invoke('respond_acp_permission', {
        sessionId,
        requestId: request?.request_id,
        optionId,
      }),
    onError: error =>
      toast.error(`Permission response failed: ${String(error)}`),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ['acp-permissions', sessionId],
      }),
  })

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<{ session_id: string }>(
      'chat:acp_permissions_changed',
      event => {
        if (event.payload.session_id === sessionId) {
          void queryClient.invalidateQueries({
            queryKey: ['acp-permissions', sessionId],
          })
        }
      }
    )
      .then(cleanup => {
        if (disposed) cleanup()
        else unlisten = cleanup
      })
      .catch(error =>
        toast.error(`Permission updates failed: ${String(error)}`)
      )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [queryClient, sessionId])

  useEffect(() => {
    if (!requestId) return
    useChatStore.getState().setWaitingForInput(sessionId, true)
    return () => useChatStore.getState().setWaitingForInput(sessionId, false)
  }, [sessionId, requestId])

  if (error)
    return (
      <div className="mx-4 my-2 rounded-md border p-3 text-sm">
        Cannot load permission requests.
        <Button
          variant="outline"
          size="sm"
          className="ml-2"
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    )
  if (!request) return null
  return (
    <div className="mx-4 my-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
      <p className="text-sm font-medium">
        {request.backend === 'grok' ? 'Grok' : 'Kimi'} needs permission
      </p>
      <p className="mt-1 break-words whitespace-pre-wrap text-sm text-muted-foreground">
        {request.title}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {request.options.map(option => (
          <Button
            key={option.optionId}
            size="sm"
            variant={option.kind === 'allow_once' ? 'default' : 'outline'}
            disabled={response.isPending}
            onClick={() => response.mutate(option.optionId)}
          >
            {option.kind === 'allow_once' ? 'Allow once' : 'Reject'}
          </Button>
        ))}
      </div>
    </div>
  )
}
