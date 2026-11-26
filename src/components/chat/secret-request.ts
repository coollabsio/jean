import type { ToolCall } from '@/types/chat'
import { extractJeanMcpBareToolName } from './tool-call-utils'

/** A secret the agent asked for with the Jean MCP `request_secret` tool. */
export interface SecretRequest {
  label: string
  reason: string
  placeholder?: string
  /** Text area instead of a one-line input, for example a whole .env file */
  multiline: boolean
  /** Expected format with fake values */
  example?: string
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function isSecretRequestTool(tool: ToolCall): boolean {
  return extractJeanMcpBareToolName(tool.name) === 'request_secret'
}

/** A successful `list_secrets` call: the chat shows the secrets card. */
export function isSecretListTool(tool: ToolCall): boolean {
  return (
    !tool.is_error && extractJeanMcpBareToolName(tool.name) === 'list_secrets'
  )
}

/** Request of a successful `request_secret` call (see `jean_mcp_core.rs`). */
export function secretRequest(tool: ToolCall): SecretRequest | null {
  if (tool.is_error || !isSecretRequestTool(tool)) return null
  const input = (tool.input ?? {}) as Record<string, unknown>
  const label = str(input.label)
  if (!label) return null
  const example = str(input.example)
  return {
    label,
    reason: str(input.reason) ?? '',
    placeholder: str(input.placeholder),
    multiline: input.multiline === true || !!example?.includes('\n'),
    example,
  }
}

/** How long Jean keeps a saved secret (`SecretRetention` in `secrets.rs`). */
export type SecretRetention = 'forever' | 'day'

/** Saved secret of a request (`SavedSecret` in `secrets.rs`). */
export interface SavedSecret {
  path: string
  retention: SecretRetention
}

/** One saved secret from `list_secrets` (`SecretEntry` in `secrets.rs`). */
export interface SecretEntry {
  id: string
  label: string
  sessionId: string
  toolCallId: string
  /** `project:<id>` or `agent:<id>`; empty for secrets saved before scope */
  ownerId: string
  /** Project or agent name */
  ownerName: string
  retention: SecretRetention
  /** Unix seconds */
  savedAt: number
}

export function secretRetentionText(retention: SecretRetention): string {
  return retention === 'day'
    ? 'deleted after 24 hours'
    : 'kept until the user deletes it'
}

/** User message after a save. It holds the file path, never the value. */
export function secretSavedMessage(label: string, saved: SavedSecret): string {
  return `I saved "${label}" to a private file: ${saved.path}\nRead it only inside a shell command, for example TOKEN="$(cat '${saved.path}')". Do not print the value. The file is ${secretRetentionText(saved.retention)}.`
}

/** The agent needs this message, the user does not: the chat hides it. */
export function isSecretSavedMessage(content: string): boolean {
  return /^I saved ".*" to a private file: /.test(content)
}

export function secretDeclinedMessage(label: string): string {
  return `I declined to give "${label}".`
}

/**
 * One user message for all secret requests of an assistant message, or null
 * while a request has no answer. Saved answers go first, so the chat hides the
 * message (see `isSecretSavedMessage`).
 */
export function combinedSecretAnswers(
  requestIds: string[],
  answers: Partial<Record<string, string>>
): string | null {
  const texts: string[] = []
  for (const id of requestIds) {
    const text = answers[id]
    if (text === undefined) return null
    texts.push(text)
  }
  if (texts.length === 0) return null
  const saved = texts.filter(isSecretSavedMessage)
  return [...saved, ...texts.filter(text => !saved.includes(text))].join('\n\n')
}
