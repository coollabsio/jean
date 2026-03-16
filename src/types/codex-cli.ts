/**
 * Types for Codex CLI management
 */

export interface CodexCliStatus {
  installed: boolean
  version: string | null
  path: string | null
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
  modelLimits: CodexAdditionalUsageLimit[]
  fetchedAt: number
}
