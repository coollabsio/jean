import type {
  BlockedImportPath,
  UnmanagedWorktree,
  UnmanagedWorktreeListing,
} from '@/types/projects'

export const IMPORT_EXISTING_WORKTREE_EVENT = 'import-existing-worktree'

export interface ImportExistingWorktreeDetail {
  projectId: string
}

/**
 * Compare import paths the way the dialog can without asking the OS to
 * canonicalize. Trailing separators are ignored. The backend also resolves
 * the real path when the directory exists.
 */
export function comparableImportPath(path: string): string {
  const trimmed = path.trim()
  const stripped = trimmed.replace(/[\\/]+$/, '')
  return stripped.length === 0 ? trimmed : stripped
}

/** Error when `path` is the project checkout or the repo's main worktree. */
export function existingWorktreeImportBlock(
  path: string,
  blockedPaths: BlockedImportPath[]
): string | null {
  const key = comparableImportPath(path)
  if (!key) return null
  const match = blockedPaths.find(
    blocked => comparableImportPath(blocked.path) === key
  )
  if (!match) return null
  const display = path.trim()
  if (match.kind === 'main') {
    return `Cannot import the repository's main checkout: ${display}`
  }
  return `Cannot import the project checkout: ${display}`
}

/** Accept the current listing object and the previous bare-array payload. */
export function parseUnmanagedWorktreeListing(
  value: unknown
): UnmanagedWorktreeListing {
  if (Array.isArray(value)) {
    return {
      worktrees: value as UnmanagedWorktree[],
      blockedPaths: [],
    }
  }
  if (value && typeof value === 'object') {
    const record = value as {
      worktrees?: unknown
      blockedPaths?: unknown
    }
    if (Array.isArray(record.worktrees)) {
      return {
        worktrees: record.worktrees as UnmanagedWorktree[],
        blockedPaths: Array.isArray(record.blockedPaths)
          ? (record.blockedPaths as BlockedImportPath[])
          : [],
      }
    }
  }
  throw new Error('Failed to list unmanaged worktrees')
}

/** Ask the import dialog to open for a project. Nothing is imported. */
export function requestImportExistingWorktree(projectId: string) {
  window.dispatchEvent(
    new CustomEvent<ImportExistingWorktreeDetail>(
      IMPORT_EXISTING_WORKTREE_EVENT,
      { detail: { projectId } }
    )
  )
}
