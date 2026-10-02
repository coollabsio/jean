/**
 * Types for Devin CLI management.
 */

export interface DevinCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface DevinAuthStatus {
  authenticated: boolean
  error: string | null
  timedOut?: boolean
}

export interface DevinModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export interface DevinReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
}

export interface DevinInstallCommand {
  command: string
  args: string[]
  description: string
}
