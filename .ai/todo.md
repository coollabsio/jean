# Resolve merge conflicts

- [x] Inspect the active Git operation and conflicting file.
- [x] Compare the index versions of `.ai/todo.md`.
- [x] Resolve the delete/modify conflict with the current task record.
- [x] Stage the resolved file and continue the merge.
- [x] Confirm that no later conflicts appeared.
- [x] Verify that the merge is complete and the branch is ready to push.

## Review

- The conflict was a delete/modify conflict. `origin/main` deleted
  `.ai/todo.md`, while this branch kept a completed conflict-resolution record.
- Repository instructions require `.ai/todo.md` to track the current task, so
  the resolution keeps the file and replaces the stale record with this one.
- `git merge --continue` completed the merge. No later conflicts appeared.

## How to test

- Run `git diff --check` and confirm that it reports no errors.
- Run `git diff --name-only --diff-filter=U` and confirm that it prints nothing.
- Run `git status --short --branch` and confirm that the worktree is clean and
  no merge is in progress.
