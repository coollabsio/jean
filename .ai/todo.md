# Resolve merge conflicts

- [x] Inspect the active Git operation and conflicting file.
- [x] Compare both versions of `.ai/todo.md`.
- [x] Replace stale task records with the current task record.
- [x] Stage the resolved file and verify that no conflict markers remain.
- [x] Continue the merge and resolve any later conflicts.
- [x] Verify that the branch is ready to push.

## Review

- `.ai/todo.md` had two stale task records: the PR review from the branch and
  lessons maintenance from `origin/main`.
- Replaced both records with the current conflict-resolution record because
  `.ai/todo.md` is reset for each new task.
- Staged the resolution and completed the merge with no later conflicts.
