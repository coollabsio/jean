# Resolve merge conflicts

- [x] Inspect the active Git operation and both conflict stages.
- [x] Resolve `.ai/todo.md` with one accurate current-task record.
- [x] Stage the resolved file and continue the merge.
- [x] Confirm that no later conflicts appeared.
- [x] Verify that the merge is complete and the branch is ready to push.

## Review

- The current index has an add/add conflict: both merge sides added different
  records for the same earlier conflict-resolution task.
- Keep one current task record because repository policy requires `.ai/todo.md`.
- `git merge --continue` completed the merge. No later conflicts appeared.

## How to test

- Run `git diff --check` and confirm that it reports no errors.
- Run `git diff --name-only --diff-filter=U` and confirm that it prints nothing.
- Run `git status --short --branch` and confirm that the worktree is clean and
  no merge is in progress.
