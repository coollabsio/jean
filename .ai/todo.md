# PR #690 — investigate and fix

- [x] Validate PR (open, no reviews, merges cleanly with main)
- [x] Run PR tests (vitest terminal-lifecycle + sounds pass)
- [x] Notification matcher: exact-match semantics drop `worker_permission_prompt` → list both
- [x] Add `StopFailure` hook (API error ends turn without `Stop`)
- [x] Claude terminals: Enter must not flip to working (menus, dialogs, local slash commands); Esc / Ctrl-C settles to idle (interrupt has no hook)
- [x] Tests for the above, then cargo test + clippy for jean-core

## Result
- Fixed all 4 items in `jean-core/src/terminal/attention.rs` + `commands.rs`; docs updated.
- `cargo test terminal::` 38 passed; rustfmt clean; no clippy findings in `src/terminal/` (other clippy errors pre-exist with local clippy 0.1.98).
- Real Claude CLI 2.1.302 with the injected `--settings` wrote valid UserPromptSubmit/Stop/SessionEnd lines.
- Not tested in the running desktop app (native PTY UI).
