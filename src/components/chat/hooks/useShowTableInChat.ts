import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { chatQueryKeys, useLoadOlderMessages } from '@/services/chat'
import {
  REVEAL_CHAT_MESSAGE_EVENT,
  findTableMessageIndex,
  findTableMessageIndexByMarkdown,
  scrollToRenderedTable,
  tableKeyForMessage,
  type RevealChatMessageDetail,
} from '@/lib/pinned-table-reveal'
import { useChatStore } from '@/store/chat-store'
import type { ChatMessage, Session } from '@/types/chat'
import type { VirtualizedMessageListHandle } from '../VirtualizedMessageList'

interface ShowTableInChatOptions {
  sessionId: string | null | undefined
  isCompact: boolean
  /** First message index shown while compact history is collapsed */
  compactStartIndex: number
  isCompactHistoryExpanded: boolean
  onExpandCompactHistory: () => void
  listRef: RefObject<VirtualizedMessageListHandle | null>
  /** Stop auto-scroll to bottom so it does not undo the jump to the table */
  stopFollowingTail: () => void
}

const nextFrame = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

async function afterRender() {
  await nextFrame()
  await nextFrame()
}

/**
 * Scroll to a pinned table in the chat. Loads older runs from disk, expands
 * hidden compact prompts, and opens the compact activity row when the table is
 * not rendered yet.
 */
export function useShowTableInChat(options: ShowTableInChatOptions) {
  const queryClient = useQueryClient()
  const { mutateAsync: loadOlder } = useLoadOlderMessages()
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })

  return useCallback(
    async (tableKey: string) => {
      const { sessionId } = latest.current
      if (!sessionId) return
      latest.current.stopFollowingTail()
      const readSession = () =>
        queryClient.getQueryData<Session>(chatQueryKeys.session(sessionId))
      // The message id can change after pinning (an optimistic reply replaced
      // by the saved one). Then find the message by the table markdown and
      // move the pin to that message.
      const markdown =
        useChatStore
          .getState()
          .pinnedTables[sessionId]?.find(p => p.key === tableKey)?.markdown ??
        ''
      let matchedByKey = true
      const findIndex = (messages: ChatMessage[]) => {
        const byKey = findTableMessageIndex(messages, tableKey)
        matchedByKey = byKey >= 0
        return matchedByKey
          ? byKey
          : findTableMessageIndexByMarkdown(messages, markdown)
      }
      const reveal = async (messageId: string | null, timeoutMs: number) => {
        if (!(await scrollToRenderedTable(tableKey, messageId, timeoutMs))) {
          return false
        }
        if (!matchedByKey && messageId) {
          const newKey = tableKeyForMessage(tableKey, messageId)
          const store = useChatStore.getState()
          const pins = store.pinnedTables[sessionId] ?? []
          if (!pins.some(p => p.key === newKey)) {
            store.renameTableKeys(sessionId, key =>
              key === tableKey ? newKey : key
            )
          }
        }
        return true
      }

      let session = readSession()
      let index = findIndex(session?.messages ?? [])
      const loadedId = session?.messages[index]?.id ?? null
      if (await reveal(loadedId, 0)) return

      try {
        while (index < 0 && (session?.loaded_run_start_index ?? 0) > 0) {
          const before = session?.loaded_run_start_index ?? 0
          await loadOlder({ sessionId, beforeRunIndex: before })
          session = readSession()
          if ((session?.loaded_run_start_index ?? 0) === before) break
          index = findIndex(session?.messages ?? [])
        }
      } catch (error) {
        toast.error('Failed to load older messages', {
          description: String(error),
        })
        return
      }

      const message = session?.messages[index]
      if (!message) {
        toast.info('The message with this table is no longer in the chat')
        return
      }

      // Let older messages render so compact window values are current.
      await afterRender()
      const {
        isCompact,
        compactStartIndex,
        isCompactHistoryExpanded,
        onExpandCompactHistory,
      } = latest.current
      const compactWindowed = isCompact && !isCompactHistoryExpanded
      if (compactWindowed && index < compactStartIndex) {
        onExpandCompactHistory()
        await afterRender()
      }

      // Loading older messages can re-pin the chat to the bottom.
      latest.current.stopFollowingTail()
      window.dispatchEvent(
        new CustomEvent<RevealChatMessageDetail>(REVEAL_CHAT_MESSAGE_EVENT, {
          detail: { messageId: message.id },
        })
      )
      const listIndex =
        compactWindowed && index >= compactStartIndex
          ? index - compactStartIndex
          : index
      latest.current.listRef.current?.scrollToIndex(listIndex)

      if (!(await reveal(message.id, 2000))) {
        toast.info('Could not find this table in the chat')
      }
    },
    [queryClient, loadOlder]
  )
}
