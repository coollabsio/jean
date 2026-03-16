/**
 * Types for Claude CLI management
 */

/**
 * Status of the Claude CLI installation
 */
export interface ClaudeCliStatus {
  /** Whether Claude CLI is installed */
  installed: boolean
  /** Installed version (if any) */
  version: string | null
  /** Path to the CLI binary (if installed) */
  path: string | null
  /** Whether the CLI supports the `auth` subcommand (older CLIs lack it) */
  supports_auth_command: boolean
}

/**
 * Result of checking Claude CLI authentication status
 */
export interface ClaudeAuthStatus {
  /** Whether the CLI is authenticated (can execute queries) */
  authenticated: boolean
  /** Error message if authentication check failed */
  error: string | null
}

/**
 * Information about a Claude CLI release from GitHub
 */
export interface ReleaseInfo {
  /** Version string (e.g., "1.0.0") */
  version: string
  /** Git tag name (e.g., "v1.0.0") */
  tagName: string
  /** Publication date in ISO format */
  publishedAt: string
  /** Whether this is a prerelease */
  prerelease: boolean
}

/**
 * Progress event during CLI installation
 */
export interface InstallProgress {
  /** Current stage of installation */
  stage: 'starting' | 'downloading' | 'installing' | 'verifying' | 'complete'
  /** Progress message */
  message: string
  /** Percentage complete (0-100) */
  percent: number
}

export interface ClaudeUsageWindowSnapshot {
  usedPercent: number
  resetsAt: number | null
}

export interface ClaudeUsageSnapshot {
  planType: string | null
  session: ClaudeUsageWindowSnapshot | null
  weekly: ClaudeUsageWindowSnapshot | null
  sonnetWeekly: ClaudeUsageWindowSnapshot | null
  extraUsageSpent: number | null
  extraUsageLimit: number | null
  fetchedAt: number
}
