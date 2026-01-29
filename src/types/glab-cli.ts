/**
 * Types for GitLab CLI integration
 */

/**
 * Status of the GitLab CLI installation
 */
export interface GlabCliStatus {
  /** Whether GitLab CLI is installed */
  installed: boolean
  /** Installed version (if any) */
  version: string | null
  /** Path to the CLI binary (if installed) */
  path: string | null
}

/**
 * Result of checking GitLab CLI authentication status
 */
export interface GlabAuthStatus {
  /** Whether the CLI is authenticated */
  authenticated: boolean
  /** Error message if authentication check failed */
  error: string | null
  /** GitLab host (gitlab.com or self-hosted URL) */
  host: string | null
}

/**
 * Information about a GitLab CLI release
 */
export interface GlabReleaseInfo {
  /** Version string (e.g., "1.36.0") */
  version: string
  /** Git tag name (e.g., "v1.36.0") - camelCase alias */
  tagName: string
  /** Publication date in ISO format - camelCase alias */
  publishedAt: string
  /** Whether this is a prerelease */
  prerelease: boolean
}

/**
 * Progress event for CLI installation
 */
export interface GlabInstallProgress {
  /** Current stage of installation */
  stage:
    | 'starting'
    | 'downloading'
    | 'extracting'
    | 'installing'
    | 'verifying'
    | 'complete'
  /** Progress message */
  message: string
  /** Percentage complete (0-100) */
  percent: number
}
