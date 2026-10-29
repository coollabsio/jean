import type { ToolCall } from '@/types/chat'
import { extractJeanMcpBareToolName } from './ToolCallInline'

/** A secret the agent asked for with the Jean MCP `request_secret` tool. */
export interface SecretRequest {
  label: string
  reason: string
  placeholder?: string
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
  return {
    label,
    reason: str(input.reason) ?? '',
    placeholder: str(input.placeholder),
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
  retention: SecretRetention
  /** Unix seconds */
  savedAt: number
}

export function secretRetentionText(retention: SecretRetention): string {
  return retention === 'day'
    ? 'deleted after 24 hours'
    : 'kept until the user forgets it'
}

/** User message after a save. It holds the file path, never the value. */
export function secretSavedMessage(label: string, saved: SavedSecret): string {
  return `I saved "${label}" to a private file: ${saved.path}\nRead it only inside a shell command, for example TOKEN="$(cat '${saved.path}')". Do not print the value. The file is ${secretRetentionText(saved.retention)}.`
}

export function secretDeclinedMessage(label: string): string {
  return `I declined to give "${label}".`
}
