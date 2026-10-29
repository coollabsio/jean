import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { chatQueryKeys } from '@/services/chat'
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
import type { MessageListHandle } from '../message-list-handle'

interface ShowTableInChatOptions {
  sessionId: string | null | undefined
  /** First message index the list renders (zen mode shows only the current prompt) */
  listStartIndex: number
  listRef: RefObject<MessageListHandle | null>
  /** Stop auto-scroll to bottom so it does not undo the jump to the table */
  stopFollowingTail: () => void
}

/**
 * Scroll to a pinned table in the chat. Opens the compact activity row when
 * the table is not rendered yet.
 */
export function useShowTableInChat(options: ShowTableInChatOptions) {
  const queryClient = useQueryClient()
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

      const session = readSession()
      const index = findIndex(session?.messages ?? [])
      const message = session?.messages[index]
      if (await reveal(message?.id ?? null, 0)) return

      if (!message) {
        toast.info('The message with this table is no longer in the chat')
        return
      }

      const { listStartIndex } = latest.current
      if (index < listStartIndex) {
        toast.info('Exit zen mode to see this table in the chat')
        return
      }

      window.dispatchEvent(
        new CustomEvent<RevealChatMessageDetail>(REVEAL_CHAT_MESSAGE_EVENT, {
          detail: { messageId: message.id },
        })
      )
      latest.current.listRef.current?.scrollToIndex(index - listStartIndex)

      if (!(await reveal(message.id, 2000))) {
        toast.info('Could not find this table in the chat')
      }
    },
    [queryClient]
  )
}
