# Compact issue and PR rows

- [x] Show the new-session investigation action on desktop.
- [x] Remove issue and PR labels and PR branch names.
- [x] Reduce issue and PR row font sizes.
- [x] Run focused tests and full quality checks.
- [x] Search GitHub issues and discussions.

## Review

- Desktop issue rows now show a dedicated new-session investigation button.
- Issue and PR rows no longer render labels. PR rows no longer render head/base branch names.
- Titles use 11px text, numbers use 10px text, and row spacing is smaller.
- `bun run check:all` passed. The suite ran 2,169 frontend tests, 1,145 Jean Core tests, and 13 Tauri library tests.
- No matching GitHub issue or discussion was found.
- Jean reported no active Run environment, so live UI verification was not available.
