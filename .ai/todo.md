# Issue #734 — crash when adding a folder

- [x] Locate issue context and trace the add-folder code path.
- [x] Identify the macOS abort root cause and regression history.
- [x] Add a failing regression test.
- [x] Implement the smallest root-cause fix.
- [x] Run focused tests and `bun run check:all`.
- [x] Record investigation and verification results.

## Review

- The crash is in the native macOS folder-picker path (`tauri-plugin-dialog`
  -> `rfd` -> `NSOpenPanel`). Release builds use `panic = "abort"`, so a panic
  in that native path terminates Jean instead of returning an error to React.
- Local macOS project selection now uses the existing backend-driven
  `DirectoryBrowser`. Windows and Linux keep their native picker, and remote
  targets keep the existing in-app browser behavior.
- Added routing tests for local macOS, local non-macOS, remote backend, and
  remote target cases. The regression test failed before implementation because
  the routing helper did not exist, then passed after the fix.
- `bun run check:all` passed typecheck, lint, Rust formatting, clippy, and all
  2,393 frontend tests. Its Rust-test phase is blocked by an existing unrelated
  `Project` test fixture at `jean-core/src/projects/commands.rs:15299` that omits
  the required `sentry_base_url` field.
