# Issue #712: Codex commit failure

- [x] Read the issue body, screenshot, and comments (no comments)
- [x] Trace the Git diff commit action through the background commit job
- [x] Reproduce the incompatible backend/model state in a regression test
- [x] Review history and identify the regression window
- [x] Implement backend-side Codex model normalization
- [x] Run focused and repository quality checks

## Review

- Root cause: the commit action passed the saved commit-message model (`sonnet`) while backend resolution selected Codex. Codex rejected the Claude model before Git could create the commit.
- Fix: when commit generation resolves to Codex, keep a valid explicit Codex model; otherwise use the user's selected Codex model, with a valid built-in fallback.
- Coverage: added tests for stale Claude-model fallback and preservation of an explicit Codex model.
- Verification: `cargo check --lib`, Rust formatting, TypeScript typecheck, ESLint, Rust Clippy, and all 2,397 frontend tests passed through `bun run check:all`.
- Known baseline blocker: the Rust test phase cannot compile because an existing `Project` test fixture at `jean-core/src/projects/commands.rs:15349` lacks the required `sentry_base_url` field. This is outside this change.
