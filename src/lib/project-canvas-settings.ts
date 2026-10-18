import type { WorktreeSortMode } from '@/types/projects'

export const PROJECT_CANVAS_SORT_MODES_STORAGE_KEY =
  'jean-project-canvas-sort-modes-v1'

const VALID_SORT_MODES = new Set<WorktreeSortMode>([
  'created',
  'last_activity',
  'manual',
])

export function loadProjectCanvasSortModes(): Record<string, WorktreeSortMode> {
  if (typeof globalThis.localStorage === 'undefined') return {}

  try {
    const value = JSON.parse(
      globalThis.localStorage.getItem(PROJECT_CANVAS_SORT_MODES_STORAGE_KEY) ??
        '{}'
    ) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, WorktreeSortMode] =>
          typeof entry[1] === 'string' &&
          VALID_SORT_MODES.has(entry[1] as WorktreeSortMode)
      )
    )
  } catch {
    return {}
  }
}

export function saveProjectCanvasSortModes(
  sortModes: Record<string, WorktreeSortMode>
): void {
  if (typeof globalThis.localStorage === 'undefined') return
  try {
    globalThis.localStorage.setItem(
      PROJECT_CANVAS_SORT_MODES_STORAGE_KEY,
      JSON.stringify(sortModes)
    )
  } catch {
    // The Zustand value still works when client storage is unavailable.
  }
}
