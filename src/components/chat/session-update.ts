const HEADER = '[Jean session update]'
const FOOTER =
  'Use read_session_messages for a full transcript. Reply briefly; the user sees sub-session status in the side panel.'

export const SESSION_UPDATE_STATUSES = [
  'done',
  'failed',
  'cancelled',
  'waiting_plan',
  'question',
] as const

export type SessionUpdateStatus = (typeof SESSION_UPDATE_STATUSES)[number]

/** One finished sub-session inside the update its lead received. */
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

function parseBlock(lines: string[]): SessionUpdate | null {
  const fields = new Map<string, string>()
  let bodyStart = lines.length
  for (let i = 0; i < lines.length; i++) {
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

/**
 * Parses the message Jean queues into a lead session when sessions it started
 * through Jean MCP finish or need input: one block per sub-session (a header
 * line, `key: value` lines, `---`, then the body) and a closing footer for the
 * model. Null for any other message.
 */
export function parseSessionUpdates(text: string): SessionUpdate[] | null {
  if (!text.trimStart().startsWith(HEADER)) return null
  let lines = text.replace(/\r\n?/g, '\n').trim().split('\n')
  if (lines[0]?.trim() !== HEADER) return null
  if (lines.at(-1)?.trim() === FOOTER) lines = lines.slice(0, -1)

  const blocks: string[][] = []
  for (const line of lines) {
    if (line.trim() === HEADER) blocks.push([])
    else blocks.at(-1)?.push(line)
  }
  const updates: SessionUpdate[] = []
  for (const block of blocks) {
    const update = parseBlock(block)
    if (!update) return null
    updates.push(update)
  }
  return updates
}

const STATUS_WORD: Record<SessionUpdateStatus, string> = {
  done: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  waiting_plan: 'waiting for plan approval',
  question: 'asking a question',
}

/** "Write changelog finished, Check CI failed" */
export function describeSessionUpdates(updates: SessionUpdate[]): string {
  return updates
    .map(update => `${update.name || 'Session'} ${STATUS_WORD[update.status]}`)
    .join(', ')
}
