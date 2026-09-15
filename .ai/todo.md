# PR #650 investigation and fix

- [x] Read PR metadata, reviews, checks, and changed files.
- [x] Trace avatar storage and display behavior; identify correctness and security risks.
- [x] Add or adjust regression tests before implementation where needed.
- [x] Implement the smallest root-cause fix.
- [x] Run focused tests and quality checks.
- [x] Record review findings and verification results.

## Review

- PR intent is correct: fresh avatar paths invalidate file-URL caches.
- Fixed a data-loss case: a failed replacement copy no longer deletes the current avatar.
- Project existence is now checked before file-system changes.
- Cleanup keeps the new destination and only recognizes UUID-form replacement names or the legacy exact prefix form.
- No dependency, credential, network, command-execution, auth, or deserialization changes were found.
- Verified focused Rust and frontend tests, TypeScript typecheck, ESLint, and `git diff --check`.
