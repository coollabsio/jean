import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import type { SaveTextResponse } from '@/types/chat'

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

/** Render table data (first row = header) as a GFM markdown table. */
export function tableToMarkdown(data: string[][]): string {
  const [header, ...rows] = data
  if (!header) return ''
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`
  const separator = `| ${header.map(() => '---').join(' | ')} |`
  return [line(header), separator, ...rows.map(line)].join('\n')
}

/**
 * Chip content: the picked body rows, one plain line each, in table order.
 * No header or markdown table, to keep tokens low. A row's note is appended
 * as "Note: <text>".
 */
export function formatTableRowsPrompt(
  data: string[][],
  rows: number[],
  notes: Record<number, string> = {}
): string {
  const body = data.slice(1)
  const lines = rows
    .filter(i => body[i])
    .map(i => {
      const cells = (body[i] ?? []).map(escapeCell)
      if (notes[i]) cells.push(`Note: ${escapeCell(notes[i])}`)
      return cells.join(' | ')
    })
  if (lines.length === 0) return ''
  return `Rows from a table in this chat:\n${lines.join('\n')}\n`
}

// One operation chain per table, so fast clicks cannot create two chips.
const chains = new Map<string, Promise<void>>()

async function applyRow(
  sessionId: string,
  tableKey: string,
  rowIndex: number,
  data: string[][],
  note: string | null
): Promise<void> {
  const existing = useChatStore
    .getState()
    .pendingTextFiles[
      sessionId
    ]?.find(tf => tf.tableRows?.tableKey === tableKey)
  const prevRows = existing?.tableRows?.rows ?? []
  const notes = Object.fromEntries(
    Object.entries(existing?.tableRows?.notes ?? {}).filter(
      ([i]) => Number(i) !== rowIndex
    )
  ) as Record<number, string>
  if (note?.trim()) notes[rowIndex] = note.trim()
  const rows =
    note === null
      ? prevRows.filter(r => r !== rowIndex)
      : [...new Set([...prevRows, rowIndex])].sort((a, b) => a - b)

  if (existing && rows.length === 0) {
    useChatStore.getState().removePendingTextFile(sessionId, existing.id)
    await invoke('delete_pasted_text', { path: existing.path, sessionId })
    return
  }
  if (rows.length === 0) return

  const content = formatTableRowsPrompt(data, rows, notes)
  const tableRows = { tableKey, rows, notes }
  if (existing) {
    const size = await invoke<number>('update_pasted_text', {
      path: existing.path,
      content,
      sessionId,
    })
    useChatStore
      .getState()
      .updatePendingTextFile(sessionId, existing.id, content, size, tableRows)
    return
  }

  const result = await invoke<SaveTextResponse>('save_pasted_text', {
    content,
    filename: 'table-rows',
    sessionId,
  })
  useChatStore.getState().addPendingTextFile(sessionId, {
    ...result,
    content,
    tableRows,
  })
}

/**
 * Add a table body row to the table's prompt chip, or update its note.
 * `note === null` removes the row. The first row creates the chip; removing
 * the last row deletes it.
 */
export function setTableRowInPrompt(
  sessionId: string,
  tableKey: string,
  rowIndex: number,
  data: string[][],
  note: string | null
): Promise<void> {
  const chainKey = `${sessionId}:${tableKey}`
  const next = (chains.get(chainKey) ?? Promise.resolve())
    .then(() => applyRow(sessionId, tableKey, rowIndex, data, note))
    .catch(error => {
      toast.error('Failed to update table rows in prompt', {
        description: String(error),
      })
    })
  chains.set(chainKey, next)
  void next.finally(() => {
    if (chains.get(chainKey) === next) chains.delete(chainKey)
  })
  return next
}
