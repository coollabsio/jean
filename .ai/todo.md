# Issue #696 investigation and fix

- [x] Read the full issue and trace headless process creation.
- [x] Identify the unreaped child lifecycle and regression source.
- [x] Add failing process-reaping regression coverage.
- [x] Implement the smallest root-cause fix.
- [x] Run focused tests and `bun run check:all`.
- [x] Record findings, risks, and test steps.

## Review

- Root cause: Kimi and Grok ACP authentication checks killed their Node CLI
  children but did not call `wait()`. Repeated web status checks therefore left
  exited direct children as zombies on Linux. Some cancellation and timeout
  paths used the same unsafe lifecycle.
- Regression: Grok introduced this lifecycle in June 2026. Kimi duplicated it
  in commit `e1feb487f` on 2026-07-17. Version 0.1.72 contains both paths.
- Fix: `kill_and_reap()` centralizes termination plus collection. Kimi, Grok,
  Antigravity, and detached-launch error paths now use it where they own a child.
- Tests: the process helper test checks for kernel `ECHILD` after cleanup. The
  Kimi ACP test runs three fake authentication children and verifies that every
  direct child is reaped.
- Verification: `bun run check:all` passed, including 353 TypeScript test files
  (2,397 tests), 1,205 jean-core tests, 14 desktop tests, formatting, lint,
  TypeScript checks, and Rust clippy.
- Incidental repair: one existing `Project` test fixture lacked the required
  `sentry_base_url` field and prevented Rust test compilation. It now sets the
  field to `None`.
