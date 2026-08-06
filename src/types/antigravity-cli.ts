/**
 * Types for Antigravity CLI (`agy`) management.
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
