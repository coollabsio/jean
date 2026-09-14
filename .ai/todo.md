# Resolve merge conflict

- [x] Compare both versions of `jean-core/src/projects/storage.rs`.
- [x] Keep `save_projects_data_file` so `main` backup rotation and Windows-safe atomic writes both remain active.
- [x] Stage the resolved file and complete the merge.
- [x] Confirm that no more conflict markers or unmerged paths remain.
- [x] Run Rust format checks and focused project-storage tests.

## Review

- Merge completed in `7cbc5e9b`; no later conflicts appeared.
- `cargo fmt --manifest-path jean-core/Cargo.toml --check` passed.
- `cargo test --manifest-path jean-core/Cargo.toml projects::storage --lib --offline` passed: 6 tests, 0 failures.
- GitHub discovery: related closed issue #679 covers `projects.json` corruption; related open issue #701 covers durable unsent prompts. No matching discussions were found.
