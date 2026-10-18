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
 * Chip content: the header row plus the picked body rows, in table order.
 * When a row has a note, a "Note" column is added with the user's text.
 */
export function formatTableRowsPrompt(
  data: string[][],
  rows: number[],
  notes: Record<number, string> = {}
): string {
  const [header, ...body] = data
  if (!header) return ''
  const picked = rows.filter(i => body[i])
  const hasNotes = picked.some(i => notes[i])
  const table = hasNotes
    ? [
        [...header, 'Note'],
        ...picked.map(i => [...(body[i] ?? []), notes[i] ?? '']),
      ]
    : [header, ...picked.map(i => body[i] ?? [])]
  return `Rows referenced from a table in this chat:\n\n${tableToMarkdown(table)}\n`
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
