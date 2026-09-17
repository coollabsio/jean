# Issue #709: Antigravity installation

- [x] Read all available issue context and trace install/status code paths.
- [x] Check history to identify whether this is a regression.
- [x] Reproduce with a focused failing test or confirm an existing regression test.
- [x] Implement the smallest root-cause fix for shell invocation and installed-binary detection.
- [x] Run focused tests and `bun run check:all`.
- [x] Review the diff and document findings, risks, and test steps.

## Review

- The original installer defect came from the first Antigravity integration:
  Google's Bash script was piped into `sh`, which is `dash` in the server image.
- Commit `12b55491` already changed the pipeline to `bash`, preserved safe path
  quoting, surfaced installer output, and added regression tests.
- Commit `66b8b6af` later added login-shell fallback detection for Unix CLIs.
  This can find user-profile paths, but the headless process and its subprocesses
  still did not inherit `$HOME/.local/bin` in the official images.
- Added `/home/jean/.local/bin` to `PATH` in both server Dockerfiles. Added a
  server-image regression assertion and observed it fail before the Dockerfile fix.
- Focused server-image tests pass (8/8). `bun run check:all` passed typecheck,
  lint, formatting, clippy, and all 2,397 frontend tests. Its Rust test phase is
  blocked by a pre-existing compile error in
  `jean-core/src/projects/commands.rs:15299`: a test `Project` initializer is
  missing the unrelated `sentry_base_url` field.
