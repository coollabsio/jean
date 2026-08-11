/**
 * Types for GitLab CLI (`glab`) integration
 */

export interface GlabCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface GlabAuthStatus {
  authenticated: boolean
  error: string | null
}

export interface GlabReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
  /** snake_case aliases from Rust */
  tag_name?: string
  published_at?: string
}

export interface GlabInstallProgress {
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

export type ForgeKind = 'github' | 'gitlab' | 'unknown'
