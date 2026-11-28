import type { Query, QueryClient } from '@tanstack/react-query'
import { applyCacheInvalidationKeys } from '@/hooks/useMainWindowEventListeners'
import { invoke } from '@/lib/transport'
import { hydrateRunningSnapshot } from '@/lib/hydrate-running-snapshot'
import { logger } from '@/lib/logger'
import { refreshRunStates } from '@/services/run-states'
import { useChatStore } from '@/store/chat-store'
import type { ChatMessage, QueuedMessage, Session } from '@/types/chat'

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
  // A session tail carries the running turn and the queue. Queues are
  // refreshed too: the drain's `queue:updated` events were lost in the gap,
  // so a prompt that ran meanwhile would otherwise stay listed as queued.
  const tails = new Map<string, Promise<Session | null>>()
  const fetchTails = () => {
    const { sendingSessionIds, messageQueues } = useChatStore.getState()
    for (const sessionId of [
      ...Object.keys(sendingSessionIds),
      ...Object.keys(messageQueues),
    ]) {
      if (!tails.has(sessionId))
        tails.set(sessionId, fetchSessionTail(sessionId))
    }
  }
  fetchTails()
  await refreshRunStates(queryClient)
  // Turns found running by the run states are fetched too.
  fetchTails()
  await Promise.all(
    [...tails].map(async ([sessionId, tail]) => {
      const session = await tail
      if (!session) return
      restoreQueue(sessionId, session.queued_messages ?? [])
      const running = runningTurn(session)
      if (running) restoreRunningTurn(sessionId, running)
    })
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

/** The latest run of a session, with its queue. */
async function fetchSessionTail(sessionId: string): Promise<Session | null> {
  const { sessionWorktreeMap, worktreePaths } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined
  if (!worktreeId || !worktreePath) return null

  try {
    return await invoke<Session>('get_session', {
      worktreeId,
      worktreePath,
      sessionId,
      limit: 1,
    })
  } catch (error) {
    // The turn keeps streaming without its gap; `chat:done` loads the reply.
    logger.warn('Failed to reload session after reconnect', {
      sessionId,
      error,
    })
    return null
  }
}

/** The running turn is the last message of the latest run. */
function runningTurn(session: Session): ChatMessage | null {
  const running = session.messages.at(-1)
  return running?.role === 'assistant' && running.id.startsWith('running-')
    ? running
    : null
}

function restoreQueue(sessionId: string, queue: QueuedMessage[]): void {
  const { messageQueues } = useChatStore.getState()
  const current = messageQueues[sessionId] ?? []
  if (JSON.stringify(current) === JSON.stringify(queue)) return
  useChatStore.setState({
    messageQueues: { ...messageQueues, [sessionId]: queue },
  })
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
