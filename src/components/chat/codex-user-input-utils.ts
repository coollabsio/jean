import type { ChatMessage, CodexUserInputRequest, ToolCall } from '@/types/chat'
import { isAskUserQuestion } from '@/types/chat'

export function getCodexUserInputRequestToolCallId(
  request: CodexUserInputRequest
): string {
  return request.item_id || `codex-user-input-${request.rpc_id}`
}

export function resolveCodexUserInputResponseToolCallId(
  request: CodexUserInputRequest,
  renderedToolCallId?: string
): string {
  return renderedToolCallId ?? getCodexUserInputRequestToolCallId(request)
}

export function isSameCodexUserInputRequest(
  first: CodexUserInputRequest,
  second: CodexUserInputRequest
): boolean {
  const firstItemId = first.item_id
  const secondItemId = second.item_id

  if (firstItemId.length > 0 && secondItemId.length > 0) {
    return firstItemId === secondItemId
  }

  return first.rpc_id === second.rpc_id
}

export function upsertCodexUserInputRequest(
  requests: CodexUserInputRequest[],
  request: CodexUserInputRequest
): CodexUserInputRequest[] {
  const existingIndex = requests.findIndex(existing =>
    isSameCodexUserInputRequest(existing, request)
  )
  if (existingIndex === -1) return [...requests, request]

  const existing = requests[existingIndex]
  if (!existing) return requests

  const nextRequest =
    request.item_id.length === 0 && existing.item_id.length > 0
      ? { ...request, item_id: existing.item_id }
      : request
  if (JSON.stringify(existing) === JSON.stringify(nextRequest)) return requests

  const next = [...requests]
  next[existingIndex] = nextRequest
  return next
}

function toolCallRepresentsCodexUserInputRequest(
  toolCall: ToolCall,
  request: CodexUserInputRequest
): boolean {
  if (!isAskUserQuestion(toolCall)) return false

  const fallbackId = `codex-user-input-${request.rpc_id}`
  return (
    toolCall.id === getCodexUserInputRequestToolCallId(request) ||
    toolCall.id === fallbackId
  )
}

export function findCodexUserInputRequestByToolCallId(
  requests: CodexUserInputRequest[],
  toolCallId: string
): CodexUserInputRequest | undefined {
  return requests.find(request => {
    const fallbackId = `codex-user-input-${request.rpc_id}`
    return (
      toolCallId === getCodexUserInputRequestToolCallId(request) ||
      toolCallId === fallbackId
    )
  })
}

export function shouldRenderCodexUserInputFallback(
  request: CodexUserInputRequest | undefined,
  activeToolCalls: ToolCall[],
  persistedMessages: ChatMessage[]
): boolean {
  if (!request) return false

  if (
    activeToolCalls.some(toolCall =>
      toolCallRepresentsCodexUserInputRequest(toolCall, request)
    )
  ) {
    return false
  }

  return !persistedMessages.some(
    message =>
      message.role === 'assistant' &&
      message.tool_calls.some(toolCall =>
        toolCallRepresentsCodexUserInputRequest(toolCall, request)
      )
  )
}
