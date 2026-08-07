/**
 * Types for Codex CLI management
 */

export interface CodexCliStatus {
  installed: boolean
  version: string | null
  path: string | null
  /**
   * Linux only: whether Codex can find bubblewrap (`bwrap`) for its sandbox.
   * Omitted/null on macOS/Windows or when not installed.
   */
  sandbox_ready?: boolean | null
  /** Install guidance when sandbox_ready is false. */
  sandbox_message?: string | null
}

export interface CodexAuthStatus {
  authenticated: boolean
  error: string | null
}

export interface CodexReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
}

export interface CodexInstallProgress {
  stage:
    | 'starting'
    | 'downloading'
    | 'extracting'
    | 'installing'
    | 'verifying'
    | 'complete'
  message: string
  percent: number
}

export interface CodexUsageWindowSnapshot {
  usedPercent: number
  resetsAt: number | null
  limitWindowSeconds: number | null
}

export interface CodexAdditionalUsageLimit {
  label: string
  session: CodexUsageWindowSnapshot | null
  weekly: CodexUsageWindowSnapshot | null
}

export interface CodexUsageSnapshot {
  planType: string | null
  session: CodexUsageWindowSnapshot | null
  weekly: CodexUsageWindowSnapshot | null
  reviews: CodexUsageWindowSnapshot | null
  creditsRemaining: number | null
  rateLimitReachedType: string | null
  modelLimits: CodexAdditionalUsageLimit[]
  fetchedAt: number
}
