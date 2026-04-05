export interface SpotlightStatus {
  worktree_id: string
  project_id: string
  worktree_path: string
  root_path: string
  active: boolean
  last_synced_at: number | null
  restore_pending: boolean
  recovery_id: string
  last_error?: string | null
}
