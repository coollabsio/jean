/**
 * Types for Antigravity CLI management.
 */

export interface AntigravityCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface AntigravityAuthStatus {
  authenticated: boolean
  error: string | null
  timedOut?: boolean
}

export interface AntigravityModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export interface AntigravityReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
}

export interface AntigravityInstallCommand {
  command: string
  args: string[]
  description: string
}
