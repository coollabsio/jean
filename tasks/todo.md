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
