# Task: Add pstack skill pack to Jean

- [x] Find the existing cross-harness skill pack install flow.
- [x] Add failing frontend and Rust tests.
- [x] Add pstack install, status, reinstall, and uninstall support.
- [x] Verify the current upstream sparse checkout and skill layout.
- [x] Run focused tests and `bun run check:all`.
- [x] Search GitHub issues and discussions.

## Review

- Preferences > Opinionated now offers pstack for Claude, Codex, OpenCode, Cursor, Pi, Command Code, and Grok.
- Install fetches `cursor/plugins` with a sparse checkout and copies all 47 current pstack skill directories to native and Jean-global skill roots.
- A manifest makes uninstall remove only directories installed as part of pstack.
- Focused tests passed. `bun run check:all` passed with 2,172 frontend tests, 1,147 jean-core tests, and 13 Tauri tests.
- No matching GitHub issues, pull requests, or discussions were found.
