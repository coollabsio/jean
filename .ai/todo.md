# Issue #733: GPT 6 Astra in Magic Prompts

- [x] Read the issue and trace the Magic Prompts model source.
- [x] Compare the affected release code with the current branch and git history.
- [x] Add a focused regression test for selecting GPT 6 Astra on one Magic Prompt.
- [x] Run focused tests and the full quality gate.
- [x] Record the result and review.

## Review

- Root cause in 0.1.73: the Magic Prompts bulk preset menu was a hard-coded
  list of GPT 5.6 choices. Adding Astra to the shared Codex model catalog did
  not add it to that separate menu.
- The current branch already contains the product fix from `e7999cb8`: Magic
  Prompts now reads Codex choices from `getCatalogDefaultModelOptions()` for
  both individual and bulk model selection.
- Added a direct regression test that selects GPT 6 Astra for one Magic Prompt
  and verifies the persisted model override.
- Focused result: 36/36 MagicPromptsPane tests pass.
- `bun run check:all` passed TypeScript typecheck, ESLint, Rust formatting,
  Rust Clippy, and all 2,391 frontend tests. The final Rust test phase is
  blocked by an unrelated existing compile error in
  `jean-core/src/projects/commands.rs:15299`: a `Project` test initializer is
  missing `sentry_base_url`.
