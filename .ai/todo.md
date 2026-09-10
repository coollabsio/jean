# Select the new investigation session

- [x] Trace the modal/session race.
- [x] Delay modal opening until the backend returns the new session ID.
- [x] Open and select the exact created session.
- [x] Run focused and full quality checks.
- [x] Search GitHub issues and discussions.

## Review

- The issue action no longer opens the worktree before session creation finishes.
- The background investigation path sets the returned session ID as active, then emits `open-session-modal` with the exact session, worktree, and path.
- A regression test verifies event ordering and the selected session ID.
- `bun run check:all` passed: 2,171 frontend tests, 1,145 Jean Core tests, and 13 Tauri library tests.
- No matching GitHub issue or discussion was found.
