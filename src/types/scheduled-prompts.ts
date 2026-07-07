/**
 * Scheduled prompts — a chat prompt queued to fire when a backend usage
 * window resets (or at an explicit timestamp). Mirrors the Rust
 * `scheduled_prompts` module (camelCase serde).
 */

export type ScheduleTrigger =
  | { kind: 'sessionReset' }
  | { kind: 'weeklyReset' }
  | { kind: 'explicit'; fireAt: number }

export interface ScheduledPrompt {
  id: string
  sessionId: string
  worktreeId: string
  worktreePath: string
  prompt: string
  backend: string
  model: string | null
  trigger: ScheduleTrigger
  /** Concrete unix timestamp (seconds) the prompt fires at. */
  fireAt: number
  createdAt: number
  lastError: string | null
}

export interface CreateScheduledPromptArgs {
  sessionId: string
  worktreeId: string
  worktreePath: string
  prompt: string
  backend: string
  model?: string | null
  trigger: ScheduleTrigger
}
