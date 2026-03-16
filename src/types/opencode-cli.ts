/**
 * Types for OpenCode CLI management.
 */

export interface OpencodeCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

// Backward-compatible aliases (existing components use OpenCode* naming).
export type OpenCodeCliStatus = OpencodeCliStatus

export interface OpencodeAuthStatus {
  authenticated: boolean
  error: string | null
}
export type OpenCodeAuthStatus = OpencodeAuthStatus

export interface OpencodeReleaseInfo {
  version: string
  prerelease: boolean
}
export type OpenCodeReleaseInfo = OpencodeReleaseInfo

export interface OpencodeInstallProgress {
  stage: string
  message: string
  percent: number
}
export type OpenCodeInstallProgress = OpencodeInstallProgress
