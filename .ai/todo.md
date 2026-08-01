# Antigravity backend integration — TODO

Branch: `feat/antigravity-backend`. Approach: full **chat backend** (streaming CLI,
`agy -p --output-format stream-json`), NOT orca's TUI-observe. Template = Command Code
(headless streaming CLI).

## Rust (jean-core + src-tauri) — VERIFIED: `cargo check` clean, 989 lib tests pass
- [x] P1 `chat/types.rs`: `Backend::Antigravity` enum + Deserialize + `antigravity_session_id`
      threaded through Session/SessionMetadata/RunEntry/session-info + test
- [x] P1b All non-exhaustive `match Backend` sites fixed (handoff x2, commands.rs x6,
      projects fork-clear); most other matches had wildcards/defaults
- [x] P2 `antigravity_cli/` module (mod/config/commands) — `agy`, PATH-first detect/auth
      (credential heuristic)/models; `antigravity_cli_source` pref; `mod` in lib.rs
- [x] P3 `chat/antigravity.rs`: `execute_antigravity_headless` streaming stream-json parser
      + `execute_one_shot_antigravity` (magic prompts); exported in `chat/mod.rs`; 4 tests
- [x] P3b Wired into `chat/commands.rs` send dispatch (resume plumbing, model select,
      persist, clear, dispatch arm, post-run persist x2)
- [x] P4 `http_server/dispatch.rs`: 4 antigravity CLI command arms
- [x] P5 AppPreferences: `selected_antigravity_model` + `antigravity_cli_source` +
      `is_antigravity_model` + magic-prompt/model-select routing
      (src-tauri needs no per-command generate_handler — uses generic dispatcher)

## Frontend (src) — wired, NOT typecheck-verified (no bun/node_modules here)
- [x] TS `types/chat.ts`: `Backend` union + `antigravity_session_id`
- [x] TS `types/preferences.ts`: `CliBackend` + `backendOptions` + prefs + defaults
- [x] UI `components/icons/AntigravityIcon.tsx`
- [x] UI `components/ui/backend-label.tsx`: icon/label/beta (only exhaustive switch)
- [x] `useInstalledBackends` detection; `services/antigravity-cli.ts` + types; cli-auth status
- [~] Magic-prompt panes / NewSessionModeModal / toolbar model-options: fall through to
      defaults (functional, not compile errors) — per-backend model lists = follow-up
- [ ] `GeneralPane.tsx` login button — follow-up (agy login is Google-account/browser)
- [ ] REQUIRED before merge: `bun install && bun run typecheck && bun run lint`

## Commits at milestones
1. P1+P1b Rust enum plumbing (compiles)
2. P2 CLI module
3. P3+P3b chat executor + dispatch wiring (compiles)
4. P4+P5 dispatch + registration (compiles)
5. Frontend wiring

## Known limitations (accepted): no live tool-approval (permission allow-list per mode),
no thinking stream, usage=per-run tokens only, system prompt embedded in prompt,
no steering, PATH-only install (no Jean-managed binary yet).
