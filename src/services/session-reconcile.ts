import type { QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { applyCacheInvalidationKeys } from '@/hooks/useMainWindowEventListeners'
import { shouldClearStaleSessionStream } from '@/components/chat/session-render-target'
import { useChatStore } from '@/store/chat-store'
import type { Session } from '@/types/chat'
import type { RecentWorktreeItem } from '@/types/projects'

function findSessionLocation(
  queryClient: QueryClient,
  sessionId: string
): { worktreeId: string; worktreePath: string } | null {
  const { sessionWorktreeMap, worktreePaths } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined
  if (worktreeId && worktreePath) return { worktreeId, worktreePath }

  // Runs started on another client may not be in the store maps yet.
  for (const [, data] of queryClient.getQueriesData<{
    items: RecentWorktreeItem[]
  }>({ queryKey: ['recent-worktrees'] })) {
    const item = data?.items.find(row => row.session.id === sessionId)
    if (item) {
      return { worktreeId: item.worktree.id, worktreePath: item.worktree.path }
    }
  }
  return null
}

/**
 * Resync after a socket reconnect. chat:done and cache:invalidate events sent
 * while the socket was down are lost, so a run that finished in the gap stays
 * "sending" in this client until the session is opened.
 */
export async function reconcileSessionsAfterReconnect(
  queryClient: QueryClient,
  ownsSession: (sessionId: string) => boolean = () => true
): Promise<void> {
  applyCacheInvalidationKeys(queryClient, ['sessions'])

  const sendingIds = Object.keys(
    useChatStore.getState().sendingSessionIds
  ).filter(ownsSession)

  await Promise.all(
    sendingIds.map(async sessionId => {
      const location = findSessionLocation(queryClient, sessionId)
      if (!location) return
      const session = await invoke<Session>('get_session', {
        ...location,
        sessionId,
        limit: 1,
      }).catch(() => null)
      if (!session) return
      const lastMessage = session.messages.at(-1)
      const store = useChatStore.getState()
      if (
        shouldClearStaleSessionStream({
          isSending: !!store.sendingSessionIds[sessionId],
          lastRunStatus: session.last_run_status,
          lastMessageRole: lastMessage?.role,
          lastMessageId: lastMessage?.id,
        })
      ) {
        store.completeSession(sessionId)
      }
    })
  )
}
