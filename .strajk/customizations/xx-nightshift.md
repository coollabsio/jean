# Nightshift — Automated Codebase Maintenance

Based on upstream PR #122 (`feat(nightshift): add automated codebase maintenance system`).

## What

Background maintenance system that runs configurable code-quality checks using real Claude CLI sessions. A project-level "Nightshift" tab in settings lets you enable/configure checks, and a "Run Now" button triggers them manually. Results are viewable in a runs history modal.

## Why

Codebases accumulate lint issues, dead code, stale docs, security vulnerabilities, and test gaps over time. Nightshift automates these maintenance tasks on a schedule (or on-demand), each running as a real Claude CLI session in a dedicated worktree so it doesn't interfere with active work.

## What's included

### Rust backend (`src-tauri/src/nightshift/` — 6 new files)

- **`types.rs`** — Data models: `NightshiftConfig`, `NightshiftRun`, `CheckResult`, `SessionSource` enum, per-check settings (enable/disable, cooldown, custom prompts, post-action)
- **`checks.rs`** — 10 built-in checks with default prompts: lint-fix, dead-code removal, doc-drift, security audit, test gaps, dependency audit, type safety, error handling, performance review, config hygiene
- **`engine.rs`** — Core orchestrator: sequential checks per project, concurrent across projects. Creates a dedicated "nightshift" worktree, spawns Claude CLI sessions per check, tracks cooldowns, handles post-actions (nothing / commit / commit+PR). `RUNNING_PROJECTS` guard prevents double-runs
- **`storage.rs`** — Atomic JSON persistence with file locking, max 50 runs per project
- **`commands.rs`** — Tauri commands: `get_nightshift_config`, `update_nightshift_config`, `get_nightshift_runs`, `trigger_nightshift_run`, `nightshift_check_completed`
- **`mod.rs`** — Module re-exports

### Modified Rust files

- **`chat/codex.rs`** — Adds `tail_codex_output()` for tailing detached Codex CLI JSONL output files
- **`chat/types.rs`** — Adds `SessionSource` enum and nightshift metadata fields (`source`, `nightshift_check_id`, `nightshift_run_id`) to `Session`
- **`chat/storage.rs`** — Adds nightshift fields to session hydration defaults
- **`lib.rs`** — Registers nightshift module, commands, and `NightshiftEngine` as managed state
- **`projects/commands.rs`** — Adds `save_empty_index()` call for nightshift worktree setup
- **`projects/types.rs`** — Adds nightshift-related project type fields

### Frontend (7 new files)

- **`src/types/nightshift.ts`** — TypeScript types mirroring Rust structs
- **`src/store/nightshift-store.ts`** — Zustand store for UI state (active sessions, modal visibility)
- **`src/services/nightshift.ts`** — TanStack Query hooks for config/runs CRUD
- **`src/lib/commands/nightshift-commands.ts`** — Typed `invoke()` wrappers for all nightshift Tauri commands
- **`src/components/projects/panes/NightshiftPane.tsx`** — Settings UI: experimental banner, enable toggle, schedule time, post-action selector, per-check config with custom prompts and cooldown overrides
- **`src/components/nightshift/NightshiftRunsModal.tsx`** — Run history viewer with collapsible check results
- **`src/hooks/useNightshiftEvents.ts`** — Event bridge: listens for `nightshift:execute-check`, sends messages to CLI sessions, reports completion back to engine

### Modified frontend files

- **`MainWindow.tsx`** — Mounts `useNightshiftEvents` hook
- **`ProjectSettingsDialog.tsx`** — Adds "Nightshift" tab to project settings dialog
- **`lib/commands/index.ts`** — Re-exports nightshift commands
- **`types/chat.ts`** — Adds `source`, `nightshift_check_id`, `nightshift_run_id` to Session type

## Tweaks on top of upstream PR

1. **Merge conflict resolution**: `chat/storage.rs` session hydration — merged nightshift fields alongside our existing `highlights` field from the text-highlights customization.
2. **Missing Worktree fields**: Added `linear_issue_identifier`, `security_alert_number`, `security_alert_url`, `advisory_ghsa_id`, `advisory_url` (all `None`) to `engine.rs:269` Worktree constructor — these fields were added to the `Worktree` struct after the PR was authored.

## Dependencies

- Upstream PR #120 (worktree refactor) for `save_empty_index()` and `worktrees:changed` event — appears to already be merged into main.
- No dependency on other customizations (but conflicts with xx-text-highlights on `storage.rs` field list — resolved).

## Not yet implemented (upstream)

- Token usage / cost tracking and budget limits
- Inspiration: [marcus/nightshift](https://github.com/marcus/nightshift)
