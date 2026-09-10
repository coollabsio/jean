# Reset `.ai/todo.md` for each task

- [x] Find each synchronized default system prompt.
- [x] Add a failing assertion for the reset rule.
- [x] Add the reset rule to each prompt.
- [x] Run focused tests and quality checks.
- [x] Search GitHub issues and discussions.
- [x] Record results and test steps.

## Review

- Added a reset step to the TypeScript default prompt, the Rust default prompt, and Claude's synchronized fallback prompt.
- The rule tells agents to replace `.ai/todo.md` at the start of each new task instead of appending to it.
- The regression assertions failed before the prompt update and passed after it.
- Verification passed: 2 focused Rust tests, 24 focused TypeScript tests, Rust formatting, Prettier, and `git diff --check`.
- GitHub: [#535](https://github.com/coollabsio/jean/issues/535) is related because it reports differences between backend system prompts. This change does not fully fix that broader report. No fully fixed or similar issue or discussion was found.

## How to test

- Reset the global system prompt to its default in Settings. Confirm Task Management starts with `Reset Task File`.
- Start two separate coding tasks. Confirm the second task replaces `.ai/todo.md` instead of appending below the first task.
