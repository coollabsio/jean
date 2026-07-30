# AI Change Checkpoints

Jean automatically snapshots each worktree **before** an agent turn starts so users can review AI file changes and restore prior project state (issue #407).

## How it works

1. **Create** — On `send_chat_message`, after the run log starts, Jean captures the full working tree (tracked + untracked, excluding ignored files) as a git commit object via a temporary index. HEAD and the real index are not modified.
2. **Store** — The commit is referenced at `refs/jean/checkpoints/<id>` (survives `git gc`). Metadata lives in app-data: `ai-checkpoints/{worktree_id}.json`.
3. **Finalize** — When the run completes or is cancelled, Jean captures an end-of-turn tree and records changed files / line stats.
4. **Restore** — Users can restore individual files or the entire worktree to the checkpoint’s start tree (`git read-tree -u --reset` + `git clean -fd` for full restore).

## Commands

| Command | Purpose |
| --- | --- |
| `list_ai_checkpoints` | List checkpoints for a worktree (newest first) |
| `get_ai_checkpoint` | Fetch one checkpoint |
| `get_ai_checkpoint_diff` | Diff `start→end` (`scope: "turn"`) or `start→working tree` (`scope: "current"`) |
| `restore_ai_checkpoint` | Full worktree restore |
| `restore_ai_checkpoint_file` | Single-file restore |
| `delete_ai_checkpoint` | Drop metadata + ref |
| `finalize_ai_checkpoint` | Manual finalize (auto on run complete) |

All commands are registered in `jean-core/src/http_server/dispatch.rs` (native + web access).

## UI

- **Git Diff modal → Checkpoints tab** (shortcut `4`): history browser, per-file restore, restore-all.
- **Edited files** row on assistant messages: **Checkpoints** button opens the tab.
- Diff request may include `worktreeId` / `checkpointId` (`src/types/git-diff.ts`).

## Module map

- Backend: `jean-core/src/projects/checkpoints.rs`
- Hook: `send_chat_message` create; `RunLogWriter::complete` / `cancel` finalize
- Run metadata: `RunEntry.checkpoint_id`
- Frontend: `src/services/checkpoints.ts`, `src/components/chat/CheckpointsTabView.tsx`

## Constraints

- Not a git repo → create fails non-fatally (chat continues).
- Full restore is destructive for later uncommitted work; confirm in UI.
- Retention: last 100 checkpoints per worktree (oldest pruned).
- Empty / no-op turns still create checkpoints (useful as restore points).
