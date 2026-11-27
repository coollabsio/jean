import type { Query, QueryClient } from '@tanstack/react-query'
import { applyCacheInvalidationKeys } from '@/hooks/useMainWindowEventListeners'
import { invoke } from '@/lib/transport'
import { hydrateRunningSnapshot } from '@/lib/hydrate-running-snapshot'
import { logger } from '@/lib/logger'
import { refreshRunStates } from '@/services/run-states'
import { useChatStore } from '@/store/chat-store'
import type { ChatMessage, Session } from '@/types/chat'

/**
 * Bring a Web Access page back in line with its server after the socket
 * reconnected. Every event sent during the gap was lost, so this loads what a
 * page reload would get from `/api/init`.
 *
 * The transport holds stream events until this settles. Each running turn is
 * replaced by the server's snapshot first; the held events then pass through
 * the same replay filter a reload uses, so text already in the snapshot is
 * not shown twice.
 *
 * The chat catch-up runs before any other refetch: on a slow link the bulk
 * refetch (file lists, issues, skills) would otherwise delay the reply. The
 * turns that were running at the drop are fetched alongside the run states.
 */
export async function resyncAfterReconnect(
  queryClient: QueryClient
): Promise<void> {
  const prefetched = new Map(
    Object.keys(useChatStore.getState().sendingSessionIds).map(sessionId => [
      sessionId,
      fetchRunningTurn(sessionId),
    ])
  )
  await refreshRunStates(queryClient)
  await Promise.all(
    Object.keys(useChatStore.getState().sendingSessionIds).map(
      async sessionId => {
        const running = await (prefetched.get(sessionId) ??
          fetchRunningTurn(sessionId))
        if (running) restoreRunningTurn(sessionId, running)
      }
    )
  )
  applyCacheInvalidationKeys(queryClient, ['sessions'])
  // 'chat' was refetched by 'sessions'. 'ui-state' is owned by this client:
  // a refetch would replace it with an older debounced save.
  const refetchable = (query: Query) => {
    const key = query.queryKey[0]
    return key !== 'chat' && key !== 'ui-state'
  }
  // `cancelRefetch: false`: queries 'sessions' already reloads are not sent
  // twice.
  void queryClient.invalidateQueries(
    { predicate: query => refetchable(query) && !isExternalData(query) },
    { cancelRefetch: false }
  )
  void queryClient.invalidateQueries({
    predicate: query => refetchable(query) && isExternalData(query),
    refetchType: 'none',
  })
}

const EXTERNAL_DATA_ROOTS = new Set([
  'github',
  'git-provider',
  'files',
  'cli-skills',
  'model-catalog',
  'sentry',
  'linear',
  'plane',
])

/**
 * GitHub, issue trackers, CLI status, skills, models and file lists: large
 * or slow to load, and rarely changed by the events missed in the gap. They
 * are only marked stale and load again when their view next opens. The
 * contexts attached to a session share these roots but are session state.
 */
function isExternalData(query: Query): boolean {
  const [root, kind] = query.queryKey
  if (typeof root !== 'string') return false
  if (typeof kind === 'string' && kind.endsWith('-contexts')) return false
  return EXTERNAL_DATA_ROOTS.has(root) || root.endsWith('-cli')
}

/** The running turn is the last message of the latest run. */
async function fetchRunningTurn(
  sessionId: string
): Promise<ChatMessage | null> {
  const { sessionWorktreeMap, worktreePaths } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined
  if (!worktreeId || !worktreePath) return null

  try {
    const session = await invoke<Session>('get_session', {
      worktreeId,
      worktreePath,
      sessionId,
      limit: 1,
    })
    const running = session.messages.at(-1)
    return running?.role === 'assistant' && running.id.startsWith('running-')
      ? running
      : null
  } catch (error) {
    // The turn keeps streaming without its gap; `chat:done` loads the reply.
    logger.warn('Failed to reload running session after reconnect', {
      sessionId,
      error,
    })
    return null
  }
}

function restoreRunningTurn(sessionId: string, running: ChatMessage): void {
  const store = useChatStore.getState()
  if (!store.sendingSessionIds[sessionId]) return

  // The blocks streamed before the drop stop where the gap begins. Start
  // from the snapshot alone, as a reloaded page does.
  store.clearStreamingContentBlocks(sessionId)
  hydrateRunningSnapshot(sessionId, running, {
    allowWhileSending: true,
    dedupeReplayedOutput: true,
  })
  const text =
    running.content ||
    (running.content_blocks ?? [])
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
  if (text) store.setStreamingContent(sessionId, text)
}
