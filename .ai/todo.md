# Issue #723 investigation and fix

- [x] Read issue context and trace issue/PR data paths
- [x] Check history and identify the root cause
- [x] Add failing regression tests for list and exact lookup responses
- [x] Implement the backend-boundary discriminator
- [x] Run focused tests, compile check, formatting, and diff checks
- [x] Record findings, risks, and test steps

## Review

- Root cause: `gh issue view` can return PR-shaped data. The response previously had no runtime discriminator, so Serde accepted it as `GitHubIssue`.
- Regression: commit `fb91e522` added independent exact issue and PR lookups. A numeric PR search could therefore populate both context-picker groups.
- Fix: request `url` from every issue command, accept only `/issues/` URLs, filter list/search results, and reject non-issues from exact/detail lookups.
- Tests: list parsing excludes `/pull/` records; exact issue parsing rejects a `/pull/` record.
- Verification: both focused tests pass. `cargo check --manifest-path jean-core/Cargo.toml --lib`, Rust formatting, and `git diff --check` pass.
- Repository note: compiling tests required a temporary local correction for pre-existing `Project` test fixtures that omit `sentry_base_url`; that unrelated correction was restored and is not in this change.
