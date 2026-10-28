import type { ChatMessage } from '@/types/chat'

type MessageRoleOnly = Pick<ChatMessage, 'role'>

/**
 * First message index of the current prompt/run (zen mode shows only this).
 *
 * A run starts at the latest user message. If a recovered/partial session has
 * no user message, keep the latest message visible so the chat never blanks.
 */
export function getCurrentPromptStartIndex(
  messages: readonly MessageRoleOnly[]
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i
  }
  return Math.max(0, messages.length - 1)
}

export function remapIndexForWindow(index: number, startIndex: number): number {
  return index >= startIndex ? index - startIndex : -1
}
