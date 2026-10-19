/**
 * Git hosting provider for a project.
 *
 * Mirrors the Rust `GitProvider` enum (`src-tauri/src/projects/provider.rs`).
 * A project's provider is resolved from its `jean.json` `provider` block, or
 * auto-detected from the origin remote, defaulting to GitHub.
 */
export type GitProvider = 'github' | 'gitlab'

/**
 * The optional `provider` block in `jean.json`.
 *
 * Non-secret only — each CLI (`gh` / `glab`) manages its own auth. `host` is
 * used for self-hosted GitLab instances.
 */
export interface ProviderConfig {
  git?: GitProvider | null
  host?: string | null
}
