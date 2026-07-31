# AI Change Checkpoints

Jean automatically snapshots each worktree **before** an agent turn starts so users can review AI file changes and restore prior project state (issue #407).

## How it works

1. **Create** — On `send_chat_message`, after the run log starts, Jean captures the full working tree (tracked + untracked, excluding ignored files) as a git commit object via a temporary index. HEAD and the real index are not modified.
2. **Store** — The commit is referenced at `refs/jean/checkpoints/<id>` so they survive `git gc`. Metadata lives in app-data: `ai-checkpoints/{worktree_id}.json`.
3. **Finalize** — When the run completes or is cancelled, Jean captures an end-of-turn tree and records changed files / line stats.
4. **Restore** — Users can restore individual files, only this turn’s files (with overlap analysis), or the entire worktree to the checkpoint’s start tree.

## Multi-session / shared worktree

Checkpoints are stored **per worktree** (not per session). Multiple sessions on the same worktree share one disk tree.

Restore is layered so concurrent sessions do not silently clobber each other:

| Mode | Behavior |
| --- | --- |
| **Analyze** | Classifies each turn path as `clean`, `conflictedLaterActivity`, `conflictedWorkingTree`, or `binaryOrUnreadable` using later checkpoints’ `filesChanged` and end-snapshot vs working tree. |
| **Clean only** | Deterministically restores only clean paths from `start_commit` (requires **Approve**). |
| **Force turn files** | Restores every path this turn changed (may overwrite later session edits; requires **Approve**). |
| **AI-assisted** | For conflicted text files, builds a 3-way prompt (`BASE` / `A_END` / `CURRENT`), proposes write/delete/skip per path; user previews, then **Request approval** → **Approve**. Clean paths still restore deterministically. |
| **Full worktree** | Destructive `read-tree -u --reset` + `clean -fd` to the start snapshot (requires **Approve**). |
| **Single file** | Checkpoints tab per-file restore also requires **Approve**. |

**No restore mutates the worktree until the user explicitly approves.**

The restore dialog always shows a risk hint: undos can overwrite later work or
produce imperfect AI merges. On small screens the dialog uses a bottom-sheet
layout (safe-area aware) with full-width stacked actions.

## Commands

| Command | Purpose |
| --- | --- |
| `list_ai_checkpoints` | List checkpoints for a worktree (newest first) |
| `get_ai_checkpoint` | Fetch one checkpoint |
| `get_ai_checkpoint_diff` | Diff `start→end` (`scope: "turn"`) or `start→working tree` (`scope: "current"`) |
| `analyze_ai_checkpoint_restore` | Classify turn paths for safe restore |
| `restore_ai_checkpoint_turn` | Turn-scoped restore (`mode`: `cleanOnly` \| `allTurnFiles`) |
| `propose_ai_checkpoint_restore` | AI 3-way proposal for conflicted paths (no writes) |
| `apply_ai_checkpoint_restore_proposal` | Apply accepted AI proposals (+ optional clean paths) |
| `restore_ai_checkpoint` | Full worktree restore |
| `restore_ai_checkpoint_file` | Single-file restore |
| `delete_ai_checkpoint` | Drop metadata + ref |
| `finalize_ai_checkpoint` | Manual finalize (auto on run complete) |

All commands are registered in `jean-core/src/http_server/dispatch.rs` (native + web access).

## UI

- **Git Diff modal → Checkpoints tab** (shortcut `4`): history browser, per-file restore, **Restore turn** dialog (analysis + clean / AI / force / full).
- **User prompt row**: when the following assistant turn edited files, a **Restore** icon appears next to Copy (hover). Matches checkpoint via `userMessageId`.
- **Edited files** row on assistant messages: **Restore** button (when `userMessageId` is known). Full history remains under Git Diff → Checkpoints tab.
- Shared dialog: `CheckpointRestoreDialog` (used by tab + per-prompt button).
- Diff request may include `worktreeId` / `checkpointId` (`src/types/git-diff.ts`).

## Module map

- Backend: `jean-core/src/projects/checkpoints.rs`
- Hook: `send_chat_message` create; `RunLogWriter::complete` / `cancel` finalize
- Run metadata: `RunEntry.checkpoint_id`
- Frontend: `src/services/checkpoints.ts`, `src/types/checkpoints.ts`,
  `CheckpointsTabView.tsx`, `CheckpointRestoreDialog.tsx`,
  `CheckpointTurnRestoreButton.tsx`, `EditedFilesDisplay.tsx`, `MessageItem.tsx`

## Constraints

- Not a git repo → create fails non-fatally (chat continues).
- Full restore is destructive for later uncommitted work; confirm in UI.
- AI proposals never auto-apply; user must accept selected paths.
- AI path limited to UTF-8 text, max 8 conflicted files per proposal, truncated content.
- Retention: last 100 checkpoints per worktree (oldest pruned).
- Empty / no-op turns still create checkpoints (useful as restore points).
