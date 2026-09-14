# Resolve merge conflicts

- [x] Inspect the active Git operation and conflicting file.
- [x] Compare both index versions of `.ai/todo.md`.
- [x] Replace the conflicting stale records with one current task record.
- [x] Stage the resolved file and confirm that no conflict markers remain.
- [x] Continue the merge and resolve any later conflicts.
- [x] Verify that the merge is complete and the branch is ready to push.

## Review

- Both sides modified `.ai/todo.md` with obsolete records for earlier work.
- The resolution keeps the file because repository instructions require it for
  current task tracking, but it does not combine stale or inaccurate claims.
- `git merge --continue` completed the merge. No later conflicts appeared.

## How to test

- Run `git diff --check` and confirm that it reports no errors.
- Run `git diff --name-only --diff-filter=U` and confirm that it prints nothing.
- Run `git status --short --branch` and confirm that the worktree is clean and
  no merge is in progress.
