/**
 * Types for Hermes Agent connection, install, and Jobs (cron) control plane.
 * See docs/developer/hermes-backend.md.
 */

export interface HermesCliStatus {
  installed: boolean
  version: string | null
  path: string | null
  jeanManaged?: boolean
}

export interface HermesGatewayStatus {
  running: boolean
  serviceText?: string
}

export interface HermesConnectionStatus {
  cli: HermesCliStatus
  apiReachable: boolean
  apiAuthenticated: boolean
  baseUrl: string
  profile: string
  model: string | null
  error: string | null
  capabilities?: unknown
  gateway?: HermesGatewayStatus | null
}

export interface HermesAuthStatus {
  authenticated: boolean
  error: string | null
  gatewayRunning: boolean
}

export interface HermesInstallCommand {
  command: string
  args: string[]
  description: string
}

/** Model from authenticated Hermes providers (`list_hermes_models`). */
export interface HermesModelInfo {
  id: string
  label: string
  provider: string
  model: string
  isDefault?: boolean
}

export interface HermesJob {
  id: string
  name: string
  prompt: string
  scheduleDisplay?: string | null
  enabled: boolean
  state?: string | null
  deliver?: string | null
  skills: string[]
  workdir?: string | null
  model?: string | null
  provider?: string | null
  nextRunAt?: string | null
  lastRunAt?: string | null
  lastStatus?: string | null
  lastError?: string | null
  noAgent: boolean
  raw?: unknown
  /** Jean linkage (job index / workdir match) */
  projectId?: string | null
  worktreeId?: string | null
  worktreePath?: string | null
  sessionId?: string | null
  profile?: string | null
}

export interface HermesJobLink {
  hermesJobId: string
  projectId?: string | null
  worktreeId?: string | null
  worktreePath?: string | null
  sessionId?: string | null
  profile?: string
  createdAt?: number
}

export interface HermesJobOutput {
  jobId: string
  path?: string | null
  content?: string | null
  modifiedAt?: number | null
}

export interface HermesCreateJobRequest {
  name: string
  schedule: string
  prompt?: string
  deliver?: string | null
  skills?: string[] | null
  repeat?: number | null
  workdir?: string | null
  model?: string | null
  provider?: string | null
  script?: string | null
  noAgent?: boolean | null
  enabledToolsets?: string[] | null
  contextFrom?: string[] | null
  worktreeId?: string | null
  projectId?: string | null
}

export interface HermesScheduleFromWorktreeRequest {
  worktreeId: string
  name?: string
  schedule: string
  prompt: string
  deliver?: string
  skills?: string[]
  model?: string
  provider?: string
}

export interface HermesUpdateJobRequest {
  name?: string | null
  schedule?: string | null
  prompt?: string | null
  deliver?: string | null
  skills?: string[] | null
  skill?: string | null
  repeat?: number | null
  enabled?: boolean | null
}
