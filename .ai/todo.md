# Resolve merge conflicts

- [x] Inspect the active Git operation and conflicting file.
- [x] Compare both versions of `.ai/todo.md`.
- [x] Replace the stale task logs with this conflict-resolution record.
- [x] Stage the resolved file and check for conflict markers.
- [x] Continue the merge and check for later conflicts.
- [x] Verify that the branch is ready to push.

## Review

- `.ai/todo.md` contained two completed records for earlier tasks: the PR #685
  review on this branch and an earlier conflict-resolution task on `origin/main`.
- Neither record describes the current task. The repository rules require this
  file to be reset, so the resolution keeps one current task record.
- The production IME change is not part of this content conflict and remains
  unchanged.

## How to test

- Run `git diff --check` and confirm that it reports no errors.
- Run `git diff --name-only --diff-filter=U` and confirm that it prints nothing.
- Run `git status --short --branch` and confirm that no merge is in progress.
