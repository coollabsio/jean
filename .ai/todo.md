# Antigravity backend integration — TODO

Branch: `feat/antigravity-backend`. Approach: full **chat backend** (streaming CLI,
`agy -p --output-format stream-json`), NOT orca's TUI-observe. Template = Command Code
(headless streaming CLI).

## Rust (jean-core) — compile-verified with `cargo check -p jean-core`
- [ ] P1 `chat/types.rs`: `Backend::Antigravity` enum + Deserialize arm + `antigravity_session_id`
      field threaded through Session (struct/new/to_session/update_from_session) + test
- [ ] P1b Fix all non-exhaustive `match Backend` sites the compiler reports
      (naming.rs, handoff.rs, registry.rs, run_log.rs, commands.rs, projects/*.rs)
- [ ] P2 `antigravity_cli/` module (mod/config/commands/mcp) — binary `agy`, detect/auth,
      `antigravity_cli_source` pref; declare `mod antigravity_cli;` in lib.rs
- [ ] P3 `chat/antigravity.rs`: `execute_antigravity_headless` streaming stream-json parser
      (init/step_update/result → chat:chunk/tool/done); export in `chat/mod.rs`
- [ ] P3b Wire into `chat/commands.rs` send dispatch: resume-id plumbing, thread var,
      model select (417), session-id persist (2558/2566), clear_target_resume (3064),
      match arm (after Kimi ~4820), post-run persist (5180/5330)
- [ ] P4 `http_server/dispatch.rs`: command arms for antigravity CLI commands
- [ ] P5 register CLI commands in `src-tauri/src/lib.rs` generate_handler + AppPreferences fields

## Frontend (src) — needs `bun run check:all` (bun not on PATH here; note for user)
- [ ] TS `types/chat.ts`: `Backend` union + `antigravity_session_id`
- [ ] TS `types/preferences.ts`: `CliBackend` + `backendOptions` + `antigravity_cli_source` + `selected_antigravity_model`
- [ ] UI `components/icons/AntigravityIcon.tsx`
- [ ] UI `components/ui/backend-label.tsx`: icon/label/beta
- [ ] UI toolbar model options + `useInstalledBackends`
- [ ] Services/types `services/antigravity-cli.ts` + `types/antigravity-cli.ts`
- [ ] UI `GeneralPane.tsx` auth/login section

## Commits at milestones
1. P1+P1b Rust enum plumbing (compiles)
2. P2 CLI module
3. P3+P3b chat executor + dispatch wiring (compiles)
4. P4+P5 dispatch + registration (compiles)
5. Frontend wiring

## Known limitations (accepted): no live tool-approval (permission allow-list per mode),
no thinking stream, usage=per-run tokens only, system prompt embedded in prompt,
no steering, PATH-only install (no Jean-managed binary yet).
