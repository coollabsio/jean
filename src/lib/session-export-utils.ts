import { invoke } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import type { Session, ChatMessage, ContentBlock, ToolCall } from '@/types/chat'
import { stripAllMarkers } from '@/components/chat/message-content-utils'

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

function formatToolCall(toolCall: ToolCall): string {
  const lines: string[] = []
  lines.push(`### Tool: ${toolCall.name}`)
  lines.push('')
  lines.push('**Input:**')
  lines.push('```json')
  lines.push(JSON.stringify(toolCall.input, null, 2))
  lines.push('```')
  if (toolCall.output !== undefined && toolCall.output !== null) {
    lines.push('')
    lines.push('**Output:**')
    lines.push('```')
    lines.push(toolCall.output)
    lines.push('```')
  }
  return lines.join('\n')
}

function formatAssistantMessage(message: ChatMessage): string {
  const toolCallMap = new Map<string, ToolCall>()
  for (const tc of message.tool_calls ?? []) {
    toolCallMap.set(tc.id, tc)
  }

  const parts: string[] = []

  if (message.content_blocks && message.content_blocks.length > 0) {
    for (const block of message.content_blocks) {
      const b = block as ContentBlock
      if (b.type === 'text') {
        if (b.text.trim()) {
          parts.push(b.text.trim())
        }
      } else if (b.type === 'tool_use') {
        const tc = toolCallMap.get(b.tool_call_id)
        if (tc) {
          parts.push(formatToolCall(tc))
        }
      } else if (b.type === 'thinking') {
        if (b.thinking.trim()) {
          parts.push(`### Thinking\n\n${b.thinking.trim()}`)
        }
      }
    }
  } else {
    // Fallback: content then tool calls
    if (message.content?.trim()) {
      parts.push(message.content.trim())
    }
    for (const tc of message.tool_calls ?? []) {
      parts.push(formatToolCall(tc))
    }
  }

  return parts.join('\n\n')
}

export async function getSessionForExport(
  worktreeId: string,
  worktreePath: string,
  sessionId: string
): Promise<Session> {
  return invoke<Session>('get_session', {
    worktreeId,
    worktreePath,
    sessionId,
  })
}

function copyTextWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'

  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (isNativeApp()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return
  }

  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    if (copyTextWithExecCommand(text)) return
    throw error
  }
}

export async function writeSessionExportFile(
  worktreePath: string,
  fileName: string,
  content: string
): Promise<string> {
  const exportDir = `${worktreePath}/session-exports`
  await invoke('create_dir_all', { path: exportDir })

  const filePath = `${exportDir}/${fileName}`
  await invoke('write_file_content', { path: filePath, content })

  return `session-exports/${fileName}`
}

export function formatSessionToMarkdown(session: Session): string {
  const lines: string[] = []

  // Header
  lines.push(`# Session: ${session.name}`)
  lines.push('')
  lines.push(`Date: ${formatDate(session.created_at)}`)
  if (session.selected_model) {
    lines.push(`Model: ${session.selected_model}`)
  }
  lines.push('')

  for (const message of session.messages) {
    lines.push('---')
    lines.push('')

    if (message.role === 'user') {
      lines.push('## User')
      lines.push('')
      const clean = stripAllMarkers(message.content)
      if (clean.trim()) {
        lines.push(clean.trim())
      }
      if (message.execution_mode) {
        lines.push('')
        lines.push(`*Mode: ${message.execution_mode}*`)
      }
    } else {
      lines.push('## Assistant')
      lines.push('')
      const body = formatAssistantMessage(message)
      if (body.trim()) {
        lines.push(body)
      }
      if (message.cancelled) {
        lines.push('')
        lines.push('*[Cancelled]*')
      }
      if (message.usage) {
        const { input_tokens, output_tokens } = message.usage
        lines.push('')
        lines.push(
          `*Tokens: ${input_tokens.toLocaleString()} in / ${output_tokens.toLocaleString()} out*`
        )
      }
    }

    lines.push('')
  }

  return lines.join('\n')
}

export function generateExportFileName(sessionName: string): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const sanitized = sessionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${sanitized}-${date}.md`
}
