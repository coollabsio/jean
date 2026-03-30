# Spotlight Testing

Spotlight testing mirrors a worktree into the repository root so local tooling can run against the root checkout without moving the user off their active worktree.

## Current Design

- Spotlight is available only for non-base worktrees.
- The worktree remains the source of truth.
- Sync is one-way from worktree to repository root.
- Root changes made while Spotlight is active are disposable and can be overwritten by the next sync.

## Sync Engine

The backend lives in `src-tauri/src/projects/spotlight.rs`.

Each sync now uses a Git snapshot flow instead of copying tracked files directly from the worktree filesystem:

1. Copy the worktree index into a temporary index file.
2. Run `git add -u -- .` against the temporary index so tracked files resolve to the latest worktree contents.
3. Materialize an ephemeral snapshot commit with `git write-tree` and `git commit-tree`.
4. In the repository root, remove tracked paths that do not exist in the snapshot.
5. Project the snapshot into the root with `git checkout <snapshot> -- .`.

This keeps the user-visible behavior close to Conductor Spotlight while avoiding any visible commit on the user branch.

## Recovery Model

On activation, Spotlight records the root branch/HEAD, stashes tracked root changes, and moves non-ignored untracked files into a recovery bundle.

On deactivate or relaunch recovery, Jean:

1. Verifies the root branch and HEAD still match the activation baseline.
2. Removes Spotlight-only tracked paths.
3. Runs `git restore --source=HEAD --staged --worktree .`.
4. Restores the saved stash if one was created.
5. Copies back the saved untracked files.

If the root branch or HEAD changed while Spotlight was active, recovery fails closed and leaves the recovery bundle in place for manual intervention.
