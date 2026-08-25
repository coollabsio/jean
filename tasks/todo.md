# Refactor OpenCode CLI: npm → Direct Binary Download

## Summary

Replace npm-based OpenCode installation with direct binary download from GitHub releases.
macOS/Linux get tar.gz from GitHub. Windows keeps npm fallback (no Windows binaries in releases).

## Asset Naming Convention (from GitHub releases)

- `opencode-mac-arm64.tar.gz` / `opencode-mac-x86_64.tar.gz`
- `opencode-linux-arm64.tar.gz` / `opencode-linux-x86_64.tar.gz`
- No Windows binaries available

## Changes

### 1. `src-tauri/src/opencode_cli/config.rs`

- [x] Remove `node_modules/.bin/` from binary path — binary lives directly in `opencode-cli/opencode`
- [x] On Windows, keep `node_modules/.bin/opencode.cmd` path (npm fallback)
- [x] Update `resolve_cli_binary` and `get_cli_binary_path` accordingly
- [x] Update test

### 2. `src-tauri/src/opencode_cli/commands.rs`

- [x] **`get_available_opencode_versions`**: Replace `npm view` with GitHub API (`https://api.github.com/repos/opencode-ai/opencode/releases`) via `reqwest`. Parse release `tag_name` and `published_at`. Take latest 20.
- [x] **`install_opencode_cli`**: Replace npm install with:
  - Determine platform string (`mac-arm64`, `mac-x86_64`, `linux-arm64`, `linux-x86_64`)
  - On Windows: keep npm install as-is (no GitHub binary available)
  - On macOS/Linux: download tar.gz from `https://github.com/opencode-ai/opencode/releases/download/v{version}/opencode-{platform}.tar.gz`
  - Extract using `flate2` + `tar` (already in Cargo.toml)
  - Set executable permissions (0o755) on Unix
  - Remove macOS quarantine attribute
  - Verify binary works (`opencode --version`)
- [x] Remove `OPENCODE_NPM_PACKAGE` constant (only used on Windows now — inline it)

### 3. Frontend — no changes needed

- Types (`OpencodeReleaseInfo`) already have `version` and `prerelease` fields
- The `tag_name` and `published_at` fields exist in the Rust struct but are not in the TS type — they'll just be ignored by serde, no issue

## Dependencies

- `reqwest` — already in Cargo.toml
- `flate2` — already in Cargo.toml
- `tar` — already in Cargo.toml
- No new dependencies needed

## CPU/RAM Optimization

### Phase 1 — Project and session retention

- [x] Add lightweight worktree counts and base-session flags to the project list response
- [x] Load full worktrees only for expanded or selected projects
- [x] Keep session-list bootstrap limited to the selected project canvas
- [x] Remove the redundant startup session prefetch
- [x] Keep inactive worktree/session query caches short-lived (2 minutes)

### Phase 2 — Unread-session scanning

- [x] Add a count-only unread-session backend command
- [x] Load full unread-session data only while the unread popover is open
- [x] Invalidate the count query on session state changes

### Phase 3 — Backend CPU and I/O

- [x] Make unread/session summaries index-based and avoid duplicate metadata reads
- [x] Bound project bootstrap concurrency
- [x] Coalesce overlapping Git-status refreshes
- [x] Batch cached Git-status writes
- [x] Reduce global polling to recently active, dirty, or PR worktrees

### Phase 4 — Rendering and long-lived runtime state

- [ ] Virtualize large project-canvas lists
- [x] Add browser content-visibility containment for off-screen canvas sections
- [x] Cache canvas card derivation by session-specific state
- [x] Add an LRU/memory cap for detached terminals
- [x] Bound terminal scrollback
- [x] Dispose long-idle running renderers safely
- [x] Verify all session-keyed Zustand state is removed when sessions close
- [x] Gate off-screen canvas Git-status and terminal subscriptions

### Verification

- [x] Add focused tests for lazy loading, unread-count invalidation, and Git sweep filtering
- [ ] Measure idle CPU/RAM and query counts with many projects
- [ ] Run `bun run check:all`
