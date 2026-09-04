import { invoke } from '@/lib/transport'
import { getFilename } from '@/lib/path-utils'
import type { DroppedPath } from '@/types/chat'

/** A primed read older than this belongs to an earlier drag. */
const STALE_AFTER_MS = 2000

let pending: Promise<DroppedPath[]> | null = null
let primedAt = 0

/**
 * Read the macOS drag pasteboard while the drag session is still alive.
 *
 * `read_drag_file_paths` must run during the drag: once the drop has landed the
 * pasteboard can already be empty, which would silently downgrade every drop to
 * the upload fallback. Call this from `dragenter`/`dragover` — repeated calls
 * reuse the in-flight read until it goes stale.
 */
export function primeDragPaths(): void {
  const now = Date.now()
  if (pending && now - primedAt < STALE_AFTER_MS) return
  primedAt = now
  pending = invoke<DroppedPath[]>('read_drag_file_paths').catch(() => [])
}

/**
 * Consume the primed read, falling back to a fresh one if nothing was primed.
 *
 * Always call this at the very start of a drop handler, before any early
 * return: a drag that primes but never consumes (cancelled drag, ignored drop)
 * would otherwise hand its paths to the next drag.
 */
export async function takeDragPaths(): Promise<DroppedPath[]> {
  const primed = pending
  pending = null
  const entries = primed ? await primed : []
  if (entries.length > 0) return entries
  return invoke<DroppedPath[]>('read_drag_file_paths').catch(() => [])
}

/** Drop the primed read when the drag leaves or is cancelled. */
export function clearDragPaths(): void {
  pending = null
}

/**
 * Whether pasteboard entries describe exactly the files the DOM reported for
 * this drop. A drag that is cancelled instead of dropped leaves its read
 * behind, so matching on count alone could attach the previous drag's files.
 * Names are compared in NFC because macOS paths are NFD on disk.
 */
export function dragPathsMatchFiles(
  entries: DroppedPath[],
  files: ArrayLike<File>
): boolean {
  if (entries.length === 0 || entries.length !== files.length) return false
  const names = new Set(
    Array.from(files, file => file.name.normalize('NFC'))
  )
  return entries.every(entry =>
    names.has(getFilename(entry.path).normalize('NFC'))
  )
}
