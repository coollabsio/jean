import type { AgentTask } from '@/services/agents'
import type { ChatMessage, ToolCall } from '@/types/chat'
import { extractJeanMcpBareToolName } from '@/components/chat/ToolCallInline'
import {
  assistantTextParts,
  coalesceContentBlocks,
} from '@/components/chat/tool-call-utils'
import {
  isAgentUpdateMessage,
  isChatContinuedMessage,
  stripAllMarkers,
} from '@/components/chat/message-content-utils'

/** A message an agent sent with `message_agent` or `send_chat_message`. */
export type AgentMessageLink =
  | { kind: 'agent'; toolId: string; agentId: string; message: string }
  | {
      kind: 'session'
      toolId: string
      sessionId: string
      message: string
      worktreeId?: string
      worktreePath?: string
      name?: string
    }

export type ReplyItem =
  | { type: 'text'; texts: string[] }
  | { type: 'link'; link: AgentMessageLink; sentAt: number }
  | { type: 'approval'; toolId: string; approvalId: number }
  | { type: 'question'; toolId: string; question: AgentQuestion }

/** A decision the agent asked for with `ask_user`. */
export interface AgentQuestion {
  question: string
  options: string[]
  multiple: boolean
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  if (!output) return {}
  try {
    const value: unknown = JSON.parse(output)
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function agentMessageLink(tool: ToolCall): AgentMessageLink | null {
  if (tool.is_error) return null
  const name = extractJeanMcpBareToolName(tool.name)
  if (name !== 'message_agent' && name !== 'send_chat_message') return null
  const input = (tool.input ?? {}) as Record<string, unknown>
  const message = str(input.message) ?? ''
  if (name === 'message_agent') {
    const agentId = str(input.agentId)
    return agentId ? { kind: 'agent', toolId: tool.id, agentId, message } : null
  }
  const sessionId = str(input.sessionId)
  if (!sessionId) return null
  // Older results only have sessionId and status
  const output = parseOutput(tool.output)
  const sessionName = str(output.sessionName)
  const worktreeName = str(output.worktreeName)
  return {
    kind: 'session',
    toolId: tool.id,
    sessionId,
    message,
    worktreeId: str(output.worktreeId),
    worktreePath: str(output.worktreePath),
    name:
      worktreeName && sessionName
        ? `${worktreeName}: ${sessionName}`
        : (worktreeName ?? sessionName),
  }
}

const APPROVAL_REQUIRED_RE = /\\?"approvalRequired\\?"\s*:\s*true/
const APPROVAL_ID_RE = /\\?"approvalId\\?"\s*:\s*(\d+)/

/** Approval request ID when a gated tool call was stored for the user (`approvalRequired` result). */
export function agentApprovalId(tool: ToolCall): number | null {
  // Backends wrap MCP results differently (raw, content blocks, escaped JSON)
  const output = tool.output
  if (
    tool.is_error ||
    !output ||
    !extractJeanMcpBareToolName(tool.name) ||
    !APPROVAL_REQUIRED_RE.test(output)
  )
    return null
  const id = APPROVAL_ID_RE.exec(output)?.[1]
  return id ? Number(id) : null
}

/** Question of an `ask_user` call (see `question_from_args` in jean-core). */
export function agentQuestion(tool: ToolCall): AgentQuestion | null {
  if (tool.is_error || extractJeanMcpBareToolName(tool.name) !== 'ask_user')
    return null
  const input = (tool.input ?? {}) as Record<string, unknown>
  const question = str(input.question)
  const options = Array.isArray(input.options)
    ? input.options.filter((o): o is string => typeof o === 'string' && !!o)
    : []
  if (!question || options.length < 2) return null
  return { question, options, multiple: input.multiple === true }
}

/** User message that answers a question: the option, or one line per option. */
export function questionAnswerText(
  question: AgentQuestion,
  selected: string[]
): string {
  const chosen = question.options.filter(o => selected.includes(o))
  return question.multiple
    ? chosen.map(o => `- ${o}`).join('\n')
    : (chosen[0] ?? '')
}

/** Options that an answer message picked. Typed answers pick none. */
export function selectedOptions(
  question: AgentQuestion,
  answer: string
): string[] {
  const text = answer.trim()
  const lines = text.split('\n').map(line => line.replace(/^- /, '').trim())
  return question.options.filter(o => o === text || lines.includes(o))
}

/**
 * For each message index, the next message the user wrote (not an automatic
 * update), or undefined when the user has not written since.
 */
export function nextUserAnswers(
  messages: ChatMessage[]
): (string | undefined)[] {
  const answers: (string | undefined)[] = []
  let next: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    answers[i] = next
    const message = messages[i]
    if (
      message?.role === 'user' &&
      !isAgentUpdateMessage(message.content) &&
      !isChatContinuedMessage(message.content)
    )
      next = stripAllMarkers(message.content)
  }
  return answers
}

/**
 * Reply text of assistant messages, with one link per message sent to an
 * agent or session and one row per approval request, in order. Text between
 * links stays in one group.
 */
export function assistantReplyItems(
  group: { message: ChatMessage }[]
): ReplyItem[] {
  const items: ReplyItem[] = []
  const pushText = (text: string) => {
    if (!text) return
    const last = items[items.length - 1]
    if (last?.type === 'text') last.texts.push(text)
    else items.push({ type: 'text', texts: [text] })
  }
  for (const { message } of group) {
    if (message.role !== 'assistant') continue
    const tools = message.tool_calls ?? []
    const pushLink = (tool: ToolCall | undefined) => {
      if (!tool) return
      const link = agentMessageLink(tool)
      if (link) {
        items.push({ type: 'link', link, sentAt: message.timestamp })
        return
      }
      const approvalId = agentApprovalId(tool)
      if (approvalId !== null) {
        items.push({ type: 'approval', toolId: tool.id, approvalId })
        return
      }
      const question = agentQuestion(tool)
      if (question) items.push({ type: 'question', toolId: tool.id, question })
    }
    const blocks = message.content_blocks ?? []
    if (blocks.length === 0) {
      assistantTextParts([], message.content ?? '').forEach(pushText)
      tools.forEach(pushLink)
      continue
    }
    for (const block of coalesceContentBlocks(blocks)) {
      if (block.type === 'text') pushText(block.text.trim())
      else if (block.type === 'tool_use')
        pushLink(tools.find(t => t.id === block.tool_call_id))
    }
  }
  return items
}

/**
 * Task session that answers a `message_agent` request. The engine opens it
 * later, titled "Request from <sender>", so take the first one after the send.
 */
export function findRequestTask(
  tasks: AgentTask[],
  senderName: string,
  sentAt: number
): AgentTask | undefined {
  const title = `Request from ${senderName}`
  return tasks
    .filter(
      task =>
        task.kind === 'message' &&
        task.title === title &&
        task.createdAt >= sentAt - 5
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

const SENT_RE = /^\[Message from agent (.+?) \(`([^`]+)`\)\]\n*/
const REQUEST_RE =
  /Request from agent (.+?) \(`([^`]+)`\):\n\n([\s\S]*?)\n\nYour final reply in this turn is sent back to /

export interface AgentSentMessage {
  agentName: string
  agentId: string
  text: string
}

/** Message an agent sent to a workspace session (see `agent_message_text` in jean-core). */
export function parseAgentSentMessage(
  content: string
): AgentSentMessage | null {
  const match = SENT_RE.exec(content)
  if (!match?.[1] || !match[2]) return null
  return {
    agentName: match[1],
    agentId: match[2],
    text: content.slice(match[0].length),
  }
}

/** Request from another agent inside an automatic update (see `message_agent` in jean-core). */
export function parseAgentRequest(content: string): AgentSentMessage | null {
  if (!isAgentUpdateMessage(content)) return null
  const match = REQUEST_RE.exec(content)
  if (!match?.[1] || !match[2] || match[3] === undefined) return null
  return { agentName: match[1], agentId: match[2], text: match[3] }
}

export interface ConversationEntry {
  id: string
  /** sender: the agent that sent the message; target: who answers it */
  from: 'sender' | 'target' | 'user'
  text: string
}

/** Messages of the receiving session, as a two-sided conversation. Other automatic updates and tool activity are left out. */
export function conversationEntries(
  messages: ChatMessage[]
): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const sent =
        parseAgentSentMessage(message.content) ??
        parseAgentRequest(message.content)
      if (sent) {
        entries.push({ id: message.id, from: 'sender', text: sent.text })
      } else if (!isAgentUpdateMessage(message.content)) {
        entries.push({
          id: message.id,
          from: 'user',
          text: stripAllMarkers(message.content),
        })
      }
      continue
    }
    const text = assistantTextParts(
      message.content_blocks ?? [],
      message.content ?? ''
    ).join('\n\n')
    if (text) entries.push({ id: message.id, from: 'target', text })
  }
  return entries
}

/** Agent ID as sent by the backend (raw), matched against local or `serverId:id` keys. */
export function sameAgentId(key: string, rawId: string): boolean {
  return key === rawId || key.endsWith(`:${rawId}`)
}
