export const IMPORT_EXISTING_WORKTREE_EVENT = 'import-existing-worktree'

export interface ImportExistingWorktreeDetail {
  projectId: string
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
