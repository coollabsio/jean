const HEADER = '[Jean session update]'

export const SESSION_UPDATE_STATUSES = [
  'done',
  'failed',
  'cancelled',
  'waiting_plan',
  'question',
] as const

export type SessionUpdateStatus = (typeof SESSION_UPDATE_STATUSES)[number]

/** Result of a delegated session, sent to the session that started it. */
export interface SessionUpdate {
  /** Raw id on the server that owns the receiving session */
  sessionId: string
  /** Raw id on the server that owns the receiving session */
  worktreeId: string
  name: string
  status: SessionUpdateStatus
  body: string
}

function isStatus(value: string): value is SessionUpdateStatus {
  return (SESSION_UPDATE_STATUSES as readonly string[]).includes(value)
}

/**
 * Parses the message Jean queues into a delegating session when a session it
 * started through Jean MCP finishes or needs input: a header line,
 * `key: value` lines, `---`, then the body.
 */
export function parseSessionUpdate(text: string): SessionUpdate | null {
  if (!text.trimStart().startsWith(HEADER)) return null
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n')
  if (lines[0]?.trim() !== HEADER) return null

  const fields = new Map<string, string>()
  let bodyStart = lines.length
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (line === '---') {
      bodyStart = i + 1
      break
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    fields.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim()
    )
  }

  const sessionId = fields.get('session')
  const worktreeId = fields.get('worktree')
  const status = fields.get('status')
  if (!sessionId || !worktreeId || !status || !isStatus(status)) return null
  return {
    sessionId,
    worktreeId,
    name: fields.get('name') ?? '',
    status,
    body: lines.slice(bodyStart).join('\n').trim(),
  }
}
