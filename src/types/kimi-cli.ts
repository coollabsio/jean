/**
 * Types for Kimi Code CLI management.
 */

export interface KimiCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface KimiAuthStatus {
  authenticated: boolean
  error: string | null
  timedOut?: boolean
}

export interface KimiModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export interface KimiReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
}

export interface KimiInstallCommand {
  command: string
  args: string[]
  description: string
}
