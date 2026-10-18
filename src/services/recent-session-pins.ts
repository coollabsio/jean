import { useEffect, useMemo } from 'react'
import {
  useQueries,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { projectServerId } from '@/components/projects/server-filter'
import { isNativeApp } from '@/lib/environment'
import { listenOnRemoteServers } from '@/lib/server-connections'
import {
  parseServerResourceKey,
  serverResourceKey,
} from '@/lib/server-resource'
import { invokeForServer } from '@/lib/transport'
import { uiStateQueryKeys } from '@/services/ui-state'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Project } from '@/types/projects'
import { LOCAL_SERVER_ID, type ServerId } from '@/types/server-resource'
import type { UIState } from '@/types/ui-state'

/**
 * Pins of one remote server, as scoped IDs. `null` means the server predates
 * pin sync, so native Jean keeps that server's pins in its local UI state.
 */
type ServerPins = string[] | null

export const recentSessionPinsQueryKey = (serverId: ServerId) =>
  ['recent-session-pins', serverId] as const

function withPin(ids: string[], sessionId: string, pinned: boolean): string[] {
  const others = ids.filter(id => id !== sessionId)
  return pinned ? [...others, sessionId] : others
}

function isUnknownCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Unknown command')
}

/** Remote server that owns a session in native Jean, if any. */
function remoteOwner(sessionId: string): ServerId | null {
  if (!isNativeApp()) return null
  const serverId = parseServerResourceKey(sessionId)?.serverId
  return serverId && serverId !== LOCAL_SERVER_ID ? serverId : null
}

function scopeServerPins(serverId: ServerId, ids: string[]): string[] {
  // Scoped IDs on that server belong to its own remote servers.
  return ids
    .filter(id => !parseServerResourceKey(id))
    .map(id => serverResourceKey({ serverId, resourceId: id }))
}

async function pinOnServer(
  serverId: ServerId,
  sessionId: string,
  pinned: boolean
): Promise<string[]> {
  const pins = await invokeForServer<string[]>(
    serverId,
    'set_recent_session_pinned',
    {
      sessionId: parseServerResourceKey(sessionId)?.resourceId ?? sessionId,
      pinned,
    }
  )
  return scopeServerPins(serverId, pins)
}

/** Pins a session in the UI state that this client loads (local core or Web Access origin). */
async function setLocalPin(
  queryClient: QueryClient,
  sessionId: string,
  pinned: boolean
): Promise<void> {
  const store = useProjectsStore.getState()
  const previous = store.pinnedRecentSessionIds
  store.setPinnedRecentSessionIds(withPin(previous, sessionId, pinned))
  try {
    // An explicit server keeps scoped IDs of old remote servers in the local file.
    const pins = await invokeForServer<string[]>(
      LOCAL_SERVER_ID,
      'set_recent_session_pinned',
      { sessionId, pinned }
    )
    // UI-state persistence applies cached pins to the store on every refetch.
    queryClient.setQueryData<UIState>(uiStateQueryKeys.state(), current =>
      current ? { ...current, pinned_recent_session_ids: pins } : current
    )
    useProjectsStore.getState().setPinnedRecentSessionIds(pins)
  } catch (error) {
    useProjectsStore.getState().setPinnedRecentSessionIds(previous)
    throw error
  }
}

async function setServerPin(
  queryClient: QueryClient,
  serverId: ServerId,
  sessionId: string,
  pinned: boolean
): Promise<void> {
  const queryKey = recentSessionPinsQueryKey(serverId)
  const previous = queryClient.getQueryData<ServerPins>(queryKey) ?? []
  queryClient.setQueryData<ServerPins>(
    queryKey,
    withPin(previous, sessionId, pinned)
  )
  try {
    const pins = await pinOnServer(serverId, sessionId, pinned)
    queryClient.setQueryData<ServerPins>(queryKey, pins)
  } catch (error) {
    queryClient.setQueryData<ServerPins>(queryKey, previous)
    throw error
  }
}

/** Pins or unpins a recent session on the server that owns it. */
export async function setRecentSessionPinned(
  queryClient: QueryClient,
  sessionId: string,
  pinned: boolean
): Promise<void> {
  try {
    const serverId = remoteOwner(sessionId)
    const serverPins = serverId
      ? queryClient.getQueryData<ServerPins>(
          recentSessionPinsQueryKey(serverId)
        )
      : undefined
    if (!serverId || !Array.isArray(serverPins)) {
      await setLocalPin(queryClient, sessionId, pinned)
      return
    }
    await setServerPin(queryClient, serverId, sessionId, pinned)
    // A pin saved on this desktop before the server supported pin sync.
    if (
      !pinned &&
      useProjectsStore.getState().pinnedRecentSessionIds.includes(sessionId)
    ) {
      await setLocalPin(queryClient, sessionId, false)
    }
  } catch (error) {
    toast.error(`Failed to ${pinned ? 'pin' : 'unpin'} session: ${error}`)
  }
}

async function loadServerPins(
  queryClient: QueryClient,
  serverId: ServerId
): Promise<ServerPins> {
  let pins: string[]
  try {
    pins = scopeServerPins(
      serverId,
      await invokeForServer<string[]>(serverId, 'get_pinned_recent_session_ids')
    )
  } catch (error) {
    if (isUnknownCommandError(error)) return null
    throw error
  }

  // Move pins that this desktop saved before the server supported pin sync.
  const localPins = useProjectsStore
    .getState()
    .pinnedRecentSessionIds.filter(
      id => parseServerResourceKey(id)?.serverId === serverId
    )
  for (const sessionId of localPins) {
    pins = await pinOnServer(serverId, sessionId, true)
    await setLocalPin(queryClient, sessionId, false)
  }
  return pins
}

// Stable reference so useQueries memoizes the combined result.
const combineServerPins = (results: UseQueryResult<ServerPins>[]) =>
  results.flatMap(result => result.data ?? [])

/**
 * Pinned recent sessions for the listed projects. Native Jean merges its local
 * pins with the pins of each remote server; Web Access uses its own server.
 */
export function useRecentSessionPins(projects: Project[]): string[] {
  const queryClient = useQueryClient()
  const localPins = useProjectsStore(state => state.pinnedRecentSessionIds)
  const uiStateInitialized = useUIStore(state => state.uiStateInitialized)
  const native = isNativeApp()
  const serverKey = useMemo(
    () =>
      native
        ? [...new Set(projects.map(projectServerId))]
            .filter(serverId => serverId !== LOCAL_SERVER_ID)
            .sort()
            .join('\0')
        : '',
    [native, projects]
  )

  const serverPins = useQueries({
    queries: (serverKey ? serverKey.split('\0') : []).map(serverId => ({
      queryKey: recentSessionPinsQueryKey(serverId),
      queryFn: () => loadServerPins(queryClient, serverId),
      // Migration reads the local pins, so wait until they are restored.
      enabled: uiStateInitialized,
      staleTime: 30_000,
    })),
    combine: combineServerPins,
  })

  // Another client changed the pins on a remote server.
  useEffect(() => {
    if (!serverKey) return
    return listenOnRemoteServers<{ keys: string[] }>(
      'cache:invalidate',
      ({ payload, serverId }) => {
        if (!payload.keys.includes('ui-state')) return
        void queryClient.invalidateQueries({
          queryKey: recentSessionPinsQueryKey(serverId),
        })
      }
    )
  }, [queryClient, serverKey])

  return useMemo(
    () => [...new Set([...localPins, ...serverPins])],
    [localPins, serverPins]
  )
}
