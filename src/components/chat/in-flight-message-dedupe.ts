import type { ChatMessage, ContentBlock, ToolCall } from '@/types/chat'

interface InFlightMessageDedupOptions {
  isSending: boolean
  streamingContent: string
  streamingContentBlocks: ContentBlock[]
  streamingToolCalls: ToolCall[]
}

function blocksMatch(
  persistedBlocks: ContentBlock[],
  streamingBlocks: ContentBlock[]
): boolean {
  if (persistedBlocks.length === 0 || streamingBlocks.length === 0) return false
  if (persistedBlocks.length > streamingBlocks.length) return false

  return persistedBlocks.every((block, index) => {
    const streamingBlock = streamingBlocks[index]
    if (!streamingBlock || block.type !== streamingBlock.type) return false

    switch (block.type) {
      case 'text':
        return streamingBlock.type === 'text'
          ? streamingBlock.text.startsWith(block.text)
          : false
      case 'thinking':
        return streamingBlock.type === 'thinking'
          ? streamingBlock.thinking.startsWith(block.thinking)
          : false
      case 'tool_use':
        return streamingBlock.type === 'tool_use'
          ? streamingBlock.tool_call_id === block.tool_call_id
          : false
    }
  })
}

function toolCallsMatch(
  persistedToolCalls: ToolCall[],
  streamingToolCalls: ToolCall[]
): boolean {
  if (persistedToolCalls.length === 0 || streamingToolCalls.length === 0) {
    return false
  }
  if (persistedToolCalls.length > streamingToolCalls.length) return false

  return persistedToolCalls.every((toolCall, index) => {
    const streamingToolCall = streamingToolCalls[index]
    return (
      streamingToolCall?.id === toolCall.id &&
      streamingToolCall.name === toolCall.name
    )
  })
}

function isTransientTrailingAssistant(
  message: ChatMessage,
  options: InFlightMessageDedupOptions
): boolean {
  if (message.id.startsWith('running-')) return true

  const normalizedPersisted = message.content.trim()
  const normalizedStreaming = options.streamingContent.trim()

  if (
    normalizedPersisted &&
    normalizedStreaming &&
    normalizedStreaming.startsWith(normalizedPersisted)
  ) {
    return true
  }

  if (
    blocksMatch(message.content_blocks ?? [], options.streamingContentBlocks)
  ) {
    return true
  }

  return toolCallsMatch(message.tool_calls, options.streamingToolCalls)
}

function hasMeaningfulPersistedPayload(message: ChatMessage): boolean {
  if (message.content.trim().length > 0) return true
  if (message.tool_calls.length > 0) return true

  return (message.content_blocks ?? []).some(block => {
    switch (block.type) {
      case 'text':
        return block.text.trim().length > 0
      case 'thinking':
        return block.thinking.trim().length > 0
      case 'tool_use':
        return block.tool_call_id.trim().length > 0
    }
  })
}

/**
 * While a session is actively streaming, React Query can briefly contain a
 * persisted assistant snapshot for the same in-flight turn. Returns true when
 * that trailing assistant should be hidden so the live StreamingMessage is the
 * only thing rendered.
 *
 * Returns a boolean (rather than a sliced array) so callers can memoize the
 * slice on `[messages, hide]` and keep a stable array reference across
 * streaming flushes.
 */
export function shouldHideInFlightAssistantMessage(
  messages: ChatMessage[],
  options: InFlightMessageDedupOptions
): boolean {
  if (!options.isSending || messages.length < 2) return false

  const lastMessage = messages[messages.length - 1]
  const previousMessage = messages[messages.length - 2]

  // If the last message is an assistant following a user message while we're
  // actively sending, hide it immediately. The backend persists the assistant
  // message to disk before streaming content reaches the frontend, creating a
  // one-render window where the message appears then gets removed by dedupe —
  // causing visible flicker (message count bounces N → N+1 → N).
  if (
    !lastMessage ||
    lastMessage.role !== 'assistant' ||
    previousMessage?.role !== 'user'
  ) {
    return false
  }

  const hasLiveStreaming =
    options.streamingContent.trim().length > 0 ||
    options.streamingContentBlocks.length > 0 ||
    options.streamingToolCalls.length > 0

  // No live streaming state for this session (e.g. resumed after an app
  // restart, or streaming buffers were cleared by a session switch). Keep a
  // meaningful persisted snapshot visible — hiding it would blank the chat
  // since there is no StreamingMessage content to take its place. Only hide
  // empty placeholders (backend persisted the assistant early).
  if (!hasLiveStreaming) {
    return !hasMeaningfulPersistedPayload(lastMessage)
  }

  return isTransientTrailingAssistant(lastMessage, options)
}

/**
 * Array-returning convenience wrapper around
 * `shouldHideInFlightAssistantMessage`.
 */
export function dedupeInFlightAssistantMessage(
  messages: ChatMessage[],
  options: InFlightMessageDedupOptions
): ChatMessage[] {
  return shouldHideInFlightAssistantMessage(messages, options)
    ? messages.slice(0, -1)
    : messages
}
