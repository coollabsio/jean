/**
 * Types for Muse Code CLI management.
 */

export interface MuseCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface MuseAuthStatus {
  authenticated: boolean
  error: string | null
  timedOut?: boolean
}

/** `id` is always the Jean model value (`muse/<model>`) once parsed by the service. */
export interface MuseModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export interface MuseInstallCommand {
  command: string
  args: string[]
  description: string
}

export interface MusePathDetection {
  found: boolean
  path: string | null
  version: string | null
  packageManager: string | null
}
