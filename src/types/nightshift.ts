// Mirrors Rust nightshift types with camelCase (matching #[serde(rename_all = "camelCase")])

export type CheckCategory =
  | 'lint'
  | 'dead_code'
  | 'documentation'
  | 'security'
  | 'tests'
  | 'dependencies'
  | 'performance'
  | 'code_quality'
  | 'type_safety'
  | 'configuration'

export type CostTier = 'low' | 'medium' | 'high'

export interface NightshiftCheck {
  id: string
  name: string
  description: string
  category: CheckCategory
  costTier: CostTier
  cooldownHours: number
  defaultEnabled: boolean
}

export type PostAction = 'nothing' | 'commit' | 'commit_and_pr'

export interface NightshiftCheckConfig {
  customPrompt?: string
  cooldownHoursOverride?: number
}

export interface NightshiftConfig {
  enabled: boolean
  disabledChecks: string[]
  extraEnabledChecks: string[]
  scheduleTime?: string
  targetBranch?: string
  model?: string
  provider?: string
  backend?: string
  postAction: PostAction
  checkConfigs: Record<string, NightshiftCheckConfig>
}

export type NightshiftRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled'

export interface CheckResult {
  checkId: string
  status: NightshiftRunStatus
  sessionId?: string
  durationSecs: number
  error?: string
}

export type RunTrigger = 'manual' | 'scheduled'

export interface NightshiftRun {
  id: string
  projectId: string
  startedAt: number
  completedAt?: number
  status: NightshiftRunStatus
  trigger: RunTrigger
  checkResults: CheckResult[]
  worktreeId?: string
  worktreePath?: string
  branchName?: string
  prUrl?: string
  prNumber?: number
}

// Event payloads
export interface RunStartedPayload {
  runId: string
  projectId: string
}

export interface CheckStartedPayload {
  runId: string
  checkId: string
  checkName: string
}

export interface CheckDonePayload {
  runId: string
  checkId: string
  status: NightshiftRunStatus
}

export interface RunCompletedPayload {
  runId: string
  projectId: string
  status: NightshiftRunStatus
  totalChecks: number
  worktreeId?: string
}

export interface RunFailedPayload {
  runId: string
  projectId: string
  error: string
}

/** Event telling frontend to execute a check by sending a message in a session */
export interface ExecuteCheckPayload {
  runId: string
  projectId: string
  checkId: string
  checkName: string
  sessionId: string
  worktreeId: string
  worktreePath: string
  prompt: string
  model?: string
  provider?: string
  backend?: string
}

export const defaultNightshiftConfig: NightshiftConfig = {
  enabled: false,
  disabledChecks: [],
  extraEnabledChecks: [],
  postAction: 'nothing',
  checkConfigs: {},
}
