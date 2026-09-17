# Issue #699: MCP session controls

- [x] Trace MCP schemas, session persistence, send resolution, and message reconstruction.
- [x] Check git history to classify the regression or missing feature.
- [x] Add failing tests for MCP settings schema and message provider metadata.
- [x] Implement the smallest complete fix across MCP, persistence, and history APIs.
- [x] Run focused tests and `bun run check:all`.
- [x] Review the diff and document findings, risks, and test steps.

## Review

- Root cause: the shared send path already inherited persisted session choices, but the MCP registry only exposed model and execution mode. Existing session setters were not available as one complete MCP control surface.
- Added `set_session_settings` for persistent backend, provider, model, fast mode, effort, thinking, and execution mode selection. Added `get_session_capabilities` and one-turn send overrides with synchronous enum validation.
- Added run provider/profile metadata to reconstructed user messages and displayed it with the existing message setting badges.
- Expanded MCP session creation to all current chat backends and documented status polling for asynchronous send failures.
- Added the missing `sentry_base_url` field to an existing Project test fixture so the required Rust test gate can compile.
- Verification: `bun run check:all` passed (353 frontend files / 2398 tests, 1204 jean-core tests, 14 Tauri library tests).
