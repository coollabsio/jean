/**
 * ClickUp integration types (mirror of the Rust structs in
 * `src-tauri/src/projects/clickup_*.rs`, serialized as camelCase).
 */

export interface ClickUpStatus {
  status: string
  color?: string
  /** "open" | "custom" | "closed" | "done" ... */
  statusType?: string
}

export interface ClickUpAssignee {
  id: number
  username?: string
  email?: string
  color?: string
  profilePicture?: string
}

export interface ClickUpTask {
  id: string
  name: string
  status?: ClickUpStatus
  assignees: ClickUpAssignee[]
  url?: string
}

/** The authenticated ClickUp user (from `GET /user`). */
export interface ClickUpMe {
  id: number
  username?: string
  email?: string
  profilePicture?: string
}

/** A selectable status transition shown in the UI dropdown. */
export interface ClickUpStatusOption {
  /** Value sent to the ClickUp API (must match the space's status name). */
  value: string
  /** Human-friendly label. */
  label: string
}

/** Persisted ClickUp configuration. */
export interface ClickUpConfig {
  token?: string
  projectTokens: Record<string, string>
  planexpoListId?: string
  sprintListId?: string
  /** Endpoint returning the full Git SHA currently served in production. */
  productionVersionUrl?: string
}
