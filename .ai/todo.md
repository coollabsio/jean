# Keep `.ai/lessons.md` concise

- [x] Add failing prompt assertions.
- [x] Add the maintenance rule to all synchronized prompts.
- [x] Run focused tests and formatting checks.
- [x] Search GitHub issues and discussions.
- [x] Record review results and test steps.

## Review

- Added the lesson-maintenance rule to the TypeScript default prompt, the Rust default prompt, and Claude's synchronized fallback prompt.
- Agents must keep lessons across tasks, merge duplicate rules, and remove obsolete entries.
- The assertions failed before the prompt update and passed after it.
- Verification passed: 2 focused Rust tests, 24 focused TypeScript tests, Rust formatting, Prettier, and `git diff --check`.
- GitHub: no fully fixed, related, or similar issue or discussion was found for `.ai/lessons.md`.

## How to test

- Reset the global system prompt to its default. Confirm the Self-Improvement Loop contains the lesson-maintenance rule.
- Add duplicate or obsolete lessons, then start a new agent session. Confirm the agent consolidates the file without clearing reusable lessons.
