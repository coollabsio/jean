import type { ToolCall } from '@/types/chat'
import {
  extractJeanMcpBareToolName,
  normalizeToolCallForDisplay,
} from './ToolCallInline'

/**
 * Status for quiet (agent) chats: the text of the latest `set_status` call
 * of the running turn. The agent writes it in a few plain words, so the user
 * sees what it does without tool names or commands. Undefined until the
 * agent calls it.
 */
export function latestAgentStatus(toolCalls: ToolCall[]): string | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const toolCall = toolCalls[i]
    if (!toolCall) continue
    const { name, input } = normalizeToolCallForDisplay(
      toolCall.name,
      (toolCall.input ?? {}) as Record<string, unknown>
    )
    if (extractJeanMcpBareToolName(name) !== 'set_status') continue
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text) return text
  }
  return undefined
}
