# Issue #716 investigation and fix

- [x] Read issue context and trace Load Context data flow.
- [x] Check history and identify the regression.
- [x] Add a failing regression test.
- [x] Implement the minimal fix.
- [x] Run focused tests and quality checks.
- [x] Record review and test instructions.

## Review

- Root cause: `list_all_sessions` returns metadata-only sessions whose
  `messages` arrays are empty, but Load Context used that array both as its
  non-empty guard and as its message-search source.
- History: the mismatch was already present when `useLoadContextData` was
  extracted in `e672fb861` (2026-02-20). It is not a recent regression in the
  current metadata/run-log architecture.
- Fix: use `message_count` for the empty-session guard and perform debounced
  content search in Rust against run logs. Keep fast name/project/worktree
  matching in the frontend.
- Tests: the regression test failed before implementation because the filter
  module did not exist, then passed after the fix. All 2,399 frontend tests,
  TypeScript, ESLint, Rust formatting, `cargo check`, and Clippy pass.
- Known baseline issue: `cargo test --manifest-path jean-core/Cargo.toml
  chat::search` cannot compile the existing Rust test suite because
  `jean-core/src/projects/commands.rs:15299` initializes `Project` without the
  existing required `sentry_base_url` field. This is unrelated to this change.

## How to test

- Open Magic → Load Context and confirm sessions with `message_count > 0` are
  listed although their `messages` arrays are not loaded.
- Confirm sessions with zero messages, the active session, and attached session
  references stay hidden.
- Search for text from a session message that is not in its session, project,
  or worktree name; confirm the session appears after the debounce.
