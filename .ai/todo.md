# Task: Install only pstack workflow skills

- [x] Add a failing test that excludes `setup-pstack`.
- [x] Remove the cross-harness configuration adaptation.
- [x] Keep all other pstack skills unchanged.
- [x] Run focused tests and `bun run check:all`.
- [x] Search GitHub issues and discussions.

## Review

- Jean installs the 46 pstack workflow skills and excludes the Cursor-only `setup-pstack` skill.
- Jean preserves the remaining upstream skill files without configuration rewrites.
- Reinstall removes `setup-pstack` when an earlier Jean installation recorded it in the pstack manifest.
- Focused tests and `bun run check:all` passed with 2,172 frontend tests, 1,148 jean-core tests, and 13 Tauri tests.
- GitHub searches found no related open or closed issues, pull requests, or discussions.
