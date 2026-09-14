# Investigate GitHub PR #685

- [x] Read repository guidance and PR metadata, discussion, reviews, and checks.
- [x] Compare the head branch with `main` and inspect the affected IME paths.
- [x] Prove the regression test fails without the guard and passes with it.
- [x] Run the PR quality gates and inspect the final diff for security concerns.
- [x] Record the review result, merge actions, and test steps.

## Review

- The PR correctly adds the shared IME guard before the modal close path.
- No reviewer comments, requested changes, dependency changes, secrets, or
  suspicious behavior were found.
- The regression test failed when the guard was temporarily removed. The two
  focused files pass 22 tests after restoration.
- TypeScript typecheck, ESLint, and `git diff --check` pass.
- No further production change is necessary. The PR needs normal maintainer
  review and any required CI jobs before merge.

## How to test

- Open a session modal and start Chinese, Japanese, or Korean IME composition.
- Press Escape while the candidate list is open. Confirm the candidates close
  and the session modal stays open.
- Press Escape when composition is not active. Confirm the modal closes.
