# Issue #710

- [x] Read the full issue context and trace the GitHub CLI update flow.
- [x] Identify the root cause and regression history.
- [x] Add a failing regression test.
- [x] Implement the smallest root-cause fix.
- [x] Run focused tests and `bun run check:all`.
- [x] Record investigation, risks, and test results below.

## Review

- The server image installs GitHub CLI as root at `/usr/bin/gh`, while Jean runs
  as the non-root `jean` user. The update resolver sees this as a PATH CLI with
  no supported package manager action, so startup auto-update emits the reported
  error. The behavior came from the server-image GitHub CLI addition in commit
  `9cf54832` and the pre-existing PATH update fallback.
- The Docker entrypoint now seeds the image binary into Jean's writable,
  persistent managed CLI directory on first start. It does not overwrite an
  existing managed binary, so later Jean updates remain intact.
- Regression tests execute the entrypoint and verify both first-start seeding
  and preservation of an existing updated binary.
- `node --test scripts/server-ci-assets.test.mjs` passes all 10 tests.
- `bun run check:all` passed typecheck, lint, Rust formatting, and clippy. The
  full frontend run had three unrelated `NewWorktreeModal` timeouts; that file
  passed all 7 tests when rerun alone. Rust tests remain blocked by the existing
  missing `sentry_base_url` field at
  `jean-core/src/projects/commands.rs:15299`.
