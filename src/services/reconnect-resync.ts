import type { QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hydrateRunningSnapshot } from '@/lib/hydrate-running-snapshot'
import { logger } from '@/lib/logger'
import { refreshRunStates } from '@/services/run-states'
import { useChatStore } from '@/store/chat-store'
import type { Session } from '@/types/chat'

/**
 * Bring a Web Access page back in line with its server after the socket
 * reconnected. Every event sent during the gap was lost, so this loads what a
 * page reload would get from `/api/init`.
 *
 * The transport holds stream events until this settles. Each running turn is
 * replaced by the server's snapshot first; the held events then pass through
 * the same replay filter a reload uses, so text already in the snapshot is
 * not shown twice.
 */
export async function resyncAfterReconnect(
  queryClient: QueryClient
): Promise<void> {
  // `refreshRunStates` refetches 'chat'. 'ui-state' is owned by this client:
  // a refetch would replace it with an older debounced save.
  void queryClient.invalidateQueries({
    predicate: query => {
      const key = query.queryKey[0]
      return key !== 'chat' && key !== 'ui-state'
    },
  })
  await refreshRunStates(queryClient, { invalidateSessions: true })
  await Promise.all(
    Object.keys(useChatStore.getState().sendingSessionIds).map(
      restoreRunningTurn
    )
  )
}

async function restoreRunningTurn(sessionId: string): Promise<void> {
  const { sessionWorktreeMap, worktreePaths } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined
  if (!worktreeId || !worktreePath) return

  try {
    // The running turn is the last message of the latest run.
    const session = await invoke<Session>('get_session', {
      worktreeId,
      worktreePath,
      sessionId,
      limit: 1,
    })
    const running = session.messages.at(-1)
    if (running?.role !== 'assistant' || !running.id.startsWith('running-')) {
      return
    }
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
  } catch (error) {
    // The turn keeps streaming without its gap; `chat:done` loads the reply.
    logger.warn('Failed to reload running session after reconnect', {
      sessionId,
      error,
    })
  }
}
