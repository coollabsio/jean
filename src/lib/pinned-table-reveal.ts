/** Window event that asks compact activity rows to open for a message. */
export const REVEAL_CHAT_MESSAGE_EVENT = 'reveal-chat-message'

export interface RevealChatMessageDetail {
  messageId: string
}

function splitTableKey(tableKey: string): { prefix: string; offset: string } {
  const at = tableKey.lastIndexOf(':')
  return at < 0
    ? { prefix: tableKey, offset: '' }
    : { prefix: tableKey.slice(0, at), offset: tableKey.slice(at + 1) }
}

/**
 * Index of the message that holds a pinned table, or -1.
 *
 * Table keys are `<messageId>:<offset>`. Compact view surfaces the latest
 * reply of a group as `compact-<firstId>[-<lastId>]:<offset>`; that text comes
 * from the group's last message, so the latest matching message wins.
 */
export function findTableMessageIndex(
  messages: readonly { id: string }[],
  tableKey: string
): number {
  const { prefix } = splitTableKey(tableKey)
  const isCompact = prefix.startsWith('compact-')
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.id
    if (!id) continue
    if (prefix === id || (isCompact && prefix.endsWith(id))) return i
  }
  return -1
}

/**
 * Index of the latest message whose text holds the pinned table markdown, or
 * -1. Fallback for pins whose message id changed after pinning.
 */
export function findTableMessageIndexByMarkdown(
  messages: readonly {
    content: string
    content_blocks?: readonly { type: string; text?: string }[]
  }[],
  markdown: string
): number {
  const needle = markdown.trim()
  if (!needle) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (
      message.content.includes(needle) ||
      message.content_blocks?.some(b => b.text?.includes(needle))
    ) {
      return i
    }
  }
  return -1
}

/** Plain table key of the same table offset in message `messageId` */
export function tableKeyForMessage(
  tableKey: string,
  messageId: string
): string {
  return `${messageId}:${splitTableKey(tableKey).offset}`
}

/**
 * Table key with message id `fromId` replaced by `toId`. Keys of other
 * messages are returned unchanged.
 */
export function renameTableKeyMessage(
  tableKey: string,
  fromId: string,
  toId: string
): string {
  const { prefix, offset } = splitTableKey(tableKey)
  if (prefix === fromId) return `${toId}:${offset}`
  if (prefix.startsWith('compact-') && prefix.endsWith(fromId)) {
    return `${prefix.slice(0, -fromId.length)}${toId}:${offset}`
  }
  return tableKey
}

/**
 * True when a rendered table key shows the same table as `tableKey`. The same
 * table can render as `<messageId>:<offset>` (full message) or as
 * `compact-...<messageId>:<offset>` (compact view latest reply).
 */
export function isSameTableKey(
  candidate: string,
  tableKey: string,
  messageId: string | null
): boolean {
  if (candidate === tableKey) return true
  if (!messageId) return false
  const { offset } = splitTableKey(tableKey)
  const plain = `${messageId}:${offset}`
  return (
    candidate === plain ||
    (candidate.startsWith('compact-') && candidate.endsWith(plain))
  )
}

function findRenderedTable(
  tableKey: string,
  messageId: string | null
): HTMLElement | null {
  const tables = Array.from(
    document.querySelectorAll<HTMLElement>('[data-table-key]')
  ).filter(el => !el.closest('[role="dialog"]'))
  return (
    tables.find(el => el.dataset.tableKey === tableKey) ??
    tables.find(el =>
      isSameTableKey(el.dataset.tableKey ?? '', tableKey, messageId)
    ) ??
    null
  )
}

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
  }
  return null
}

const STABLE_FRAMES = 3
const MAX_LAYOUT_WAIT_MS = 1500

/**
 * Wait until the table stops moving in the scroll content. A compact activity
 * row opens with a height animation and renders its messages, so a scroll that
 * starts at once stops at a stale position or is clamped by the old height.
 */
async function waitForStableLayout(target: HTMLElement): Promise<void> {
  const parent = scrollParentOf(target)
  const measure = () => {
    const top = target.getBoundingClientRect().top
    if (!parent) return `${Math.round(top)}`
    const offset = top - parent.getBoundingClientRect().top + parent.scrollTop
    return `${Math.round(offset)}:${parent.scrollHeight}`
  }
  const deadline = Date.now() + MAX_LAYOUT_WAIT_MS
  let last = measure()
  let stableFrames = 0
  while (stableFrames < STABLE_FRAMES && Date.now() < deadline) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const next = measure()
    stableFrames = next === last ? stableFrames + 1 : 0
    last = next
  }
}

/**
 * Wait until the table renders in the chat and its layout is stable, then
 * scroll to it and flash it. Returns false when it does not render within
 * `timeoutMs`.
 */
export async function scrollToRenderedTable(
  tableKey: string,
  messageId: string | null,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let target = findRenderedTable(tableKey, messageId)
  while (!target && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    target = findRenderedTable(tableKey, messageId)
  }
  if (!target) return false
  await waitForStableLayout(target)
  if (!target.isConnected) {
    target = findRenderedTable(tableKey, messageId)
    if (!target) return false
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  target.classList.remove('pinned-table-highlight')
  void target.offsetWidth // restart the animation on repeat jumps
  target.classList.add('pinned-table-highlight')
  return true
}
