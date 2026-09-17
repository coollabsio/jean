# Issue #700 — persist complete server home state

- [x] Read the full issue discussion and verify current runtime paths.
- [x] Trace image, documentation, and release-test history to confirm root cause/regression.
- [x] Add failing regression checks for the persistent home-volume contract.
- [x] Implement the smallest durable image and documentation fix.
- [x] Run focused tests and repository quality gates.
- [x] Record investigation, risks, and verification results.

## Review

- The original server Docker image introduced the narrow app-data volume. This is
  an initial container packaging defect, not a later regression.
- Default worktrees use `~/jean`, Claude and common developer tools store state
  under `$HOME`, and project records do not persist the GitHub origin URL. The
  narrow volume therefore kept metadata but lost the files needed by that metadata.
- Both server Dockerfiles now declare `/home/jean` as the volume. This keeps current
  and future HOME-based tool state without special path rewrites.
- The Docker example now mounts `jean-home:/home/jean`. Migration guidance copies
  the old app-data volume into the correct nested path and restores UID/GID 1000
  ownership. It also warns users to copy writable-layer data before removal.
- Static regression tests failed before the Docker/docs changes and now pass.
- `bun run check:all` passed typecheck, lint, Rust formatting, clippy, and all 2,397
  frontend tests. Its Rust-test phase is blocked by the existing unrelated
  `Project` fixture at `jean-core/src/projects/commands.rs:15299`, which omits the
  required `sentry_base_url` field.
