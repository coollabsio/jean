# PR #678 investigation

- [x] Read PR metadata, reviews, comments, checks, and branch diff.
- [x] Inspect changed code and related platform command behavior.
- [x] Review security, correctness, and test coverage.
- [x] Implement confirmed required changes with regression tests.
- [x] Run focused validation and record the review result.

## Review

- PR #678 correctly resolves Windows npm/npx shims and uses Rust's safe native batch-file launch path for installer and update arguments.
- No PR reviews, inline comments, or requested changes exist. GitGuardian is the only reported check and it passes.
- Found and fixed an allowlist mismatch: the frontend sends `commandcode` with a detected `cmd` or `command-code` binary, but the Rust update endpoint rejected all three values.
- Added a regression test. It failed before the allowlist fix and passes after it.
- Focused Rust tests pass: 34 WSL tests, 10 shim/audit tests, and 1 Command Code update test.
- Scoped Rust formatting, documentation Prettier, and `git diff --check` pass.
- Full `cargo fmt --check` is blocked by an unrelated existing formatting difference in `jean-core/src/chat/context_instructions.rs`.
- Security review found no dependency changes, secrets, obfuscation, or hidden network access. The existing `cli_command()` `cmd.exe /C` mode remains injection-sensitive for a no-whitespace argument with cmd metacharacters; this PR documents but does not create that older risk.
