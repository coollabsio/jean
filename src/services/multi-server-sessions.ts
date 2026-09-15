import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isNativeApp } from '@/lib/environment'
import { useRemoteConnections } from '@/lib/remote-connections'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { invoke, invokeForServer } from '@/lib/transport'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type { AllSessionsResponse } from '@/types/chat'

export interface SessionServerSource {
  serverId: string
  name: string
  online: boolean
}

export async function loadAllSessionsForServers(
  sources: SessionServerSource[],
  invokeServer: (
    serverId: string,
    command: string
  ) => Promise<AllSessionsResponse>
): Promise<AllSessionsResponse> {
  const responses = await Promise.allSettled(
    sources
      .filter(source => source.online)
      .map(async source => ({
        source,
        response: await invokeServer(source.serverId, 'list_all_sessions'),
      }))
  )

  return {
    entries: responses.flatMap(result =>
      result.status === 'fulfilled'
        ? result.value.response.entries.map(entry => ({
            ...entry,
            serverId: result.value.source.serverId,
            serverName: result.value.source.name,
          }))
        : []
    ),
  }
}

export function useConsolidatedAllSessions(enabled = true) {
  const native = isNativeApp()
  const connections = useRemoteConnections()
  const snapshots = useServerConnectionSnapshots()
  const sources: SessionServerSource[] = native
    ? [
        { serverId: LOCAL_SERVER_ID, name: 'Local', online: true },
        ...connections
          .filter(connection => connection.enabled !== false)
          .map(connection => ({
            serverId: connection.id,
            name: connection.name,
            online: snapshots.get(connection.id)?.status === 'online',
          })),
      ]
    : [{ serverId: LOCAL_SERVER_ID, name: 'This server', online: true }]
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')

  const query = useQuery({
    queryKey: ['all-sessions'],
    queryFn: () =>
      native
        ? loadAllSessionsForServers(sources, (serverId, command) =>
            invokeForServer<AllSessionsResponse>(serverId, command)
          )
        : invoke<AllSessionsResponse>('list_all_sessions'),
    enabled,
    staleTime: 60_000,
    gcTime: 120_000,
    refetchInterval: native ? 60_000 : false,
  })

  useEffect(() => {
    if (enabled) void query.refetch()
    // Refetch when the set of available instances changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sourceKey])

  return query
}
