import type { QueryClient } from '@tanstack/react-query'
import { invoke, invokeForServer } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import { applyCacheInvalidationKeys } from '@/hooks/useMainWindowEventListeners'
import { getEnabledServerConnections } from '@/lib/remote-connections'
import { serverConnectionManager } from '@/lib/server-connections'
import { parseServerResourceKey } from '@/lib/server-resource'
import { LOCAL_SERVER_ID, type ServerId } from '@/types/server-resource'
import { useChatStore, type RunStateSnapshotOptions } from '@/store/chat-store'
import { chatQueryKeys } from '@/services/chat'
import type { RunState } from '@/types/chat'
import { logger } from '@/lib/logger'

export interface RefreshRunStatesOptions {
  /** Only this server's sessions. Default: every connected server. */
  serverId?: ServerId
  /**
   * Only these sessions (scoped ids on native). The result is applied without
   * treating absent sessions as idle.
   */
  sessionIds?: string[]
  /** Also refetch session lists, for reconnects where list events were lost. */
  invalidateSessions?: boolean
}

/** Native: the local core plus every enabled remote whose socket is up. */
function connectedServerIds(): ServerId[] {
  const snapshot = serverConnectionManager.getSnapshot()
  const remotes = getEnabledServerConnections()
    .map(connection => connection.id)
    .filter(id => snapshot.get(id)?.status === 'online')
  return [LOCAL_SERVER_ID, ...remotes]
}

function ownsSessionOn(serverId: ServerId): (sessionId: string) => boolean {
  return sessionId => {
    const owner = parseServerResourceKey(sessionId)?.serverId
    return serverId === LOCAL_SERVER_ID ? !owner : owner === serverId
  }
}

/**
 * Pull the backend's versioned run states and reconcile the store from them.
 * This is the one resync path for a socket connect or reconnect, a lagged
 * socket (`ws:resync`), window focus, and opening a session. Web Access talks
 * to its origin only; native desktop asks each connected server for its own
 * sessions and keeps ids scoped by server.
 */
export async function refreshRunStates(
  queryClient: QueryClient,
  options: RefreshRunStatesOptions = {}
): Promise<void> {
  if (options.invalidateSessions) {
    applyCacheInvalidationKeys(queryClient, ['sessions'])
  }
  const requestedAt = Date.now()

  if (options.sessionIds) {
    const states = await invoke<RunState[]>('get_run_states', {
      sessionIds: options.sessionIds,
    }).catch(error => {
      logger.warn('Failed to fetch run states', { error })
      return [] as RunState[]
    })
    applySnapshot(queryClient, states, { requestedAt })
    return
  }

  if (!isNativeApp()) {
    const states = await invoke<RunState[]>('get_run_states').catch(error => {
      logger.warn('Failed to fetch run states', { error })
      return null
    })
    if (states) {
      applySnapshot(queryClient, states, {
        ownsSession: () => true,
        requestedAt,
      })
    }
    return
  }

  const serverIds = options.serverId ? [options.serverId] : connectedServerIds()
  await Promise.all(
    serverIds.map(async serverId => {
      const states = await invokeForServer<RunState[]>(
        serverId,
        'get_run_states'
      ).catch(error => {
        logger.warn('Failed to fetch run states', { serverId, error })
        return null
      })
      if (!states) return
      applySnapshot(queryClient, states, {
        ownsSession: ownsSessionOn(serverId),
        requestedAt,
      })
    })
  )
}

/**
 * A run that ended while its streamed text was still on screen (its
 * `chat:done` was missed) is refetched so the persisted reply takes the
 * stream's place instead of leaving a gap.
 */
function applySnapshot(
  queryClient: QueryClient,
  states: RunState[],
  options: RunStateSnapshotOptions
): void {
  const ended = useChatStore
    .getState()
    .applyRunStateSnapshot(states, options)
  for (const sessionId of ended) {
    void queryClient.invalidateQueries({
      queryKey: chatQueryKeys.session(sessionId),
    })
  }
}

const FOCUS_REFRESH_MIN_INTERVAL_MS = 5_000
let lastFocusRefreshAt = 0

/** Focus and visibility fire in bursts; one refresh per interval is enough. */
export function refreshRunStatesOnFocus(queryClient: QueryClient): void {
  const now = Date.now()
  if (now - lastFocusRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return
  lastFocusRefreshAt = now
  void refreshRunStates(queryClient)
}
