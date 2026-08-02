# Plan: Improve Antigravity backend (base = our jean-core impl, ref PR #469)

## Context
PR #469 (draft/conflicting, base `src-tauri`) implements the same Antigravity
backend but is more complete on UX. Our impl (base `jean-core`, branch
`feat/antigravity-backend`) is **stronger on the engine**:
- streaming `stream-json` (live text + tool-call capture + cancel via exit 130)
- system_context already injects RECAP + project/global system prompt + language
  (`build_combined_terminal_context_content`, RECAP at context_instructions.rs:143)
- `is_antigravity_model` = clean `antigravity/` prefix (NOT #469's hardcoded labels)

Goal: keep our engine, adopt #469's UX completeness + a few robustness fixes.
**Do NOT** switch to #469's final-output json executor, its label-based model
heuristic, or drop our system_context.

## P0 — Executor robustness (port from #469, small + high value)
File: `jean-core/src/chat/antigravity.rs` (+ `antigravity_cli/`)
- [ ] Port `auto_trust_workspace()`: append `working_dir` to
      `~/.gemini/antigravity-cli/settings.json` → `trustedWorkspaces[]` (create key
      if missing). Call once before spawn so headless runs don't hang on a trust
      prompt. Put in `antigravity_cli` (e.g. config.rs), call from executor.
- [ ] `env_remove` parent-agent leakage on the command: `ANTIGRAVITY_PROJECT_ID`,
      `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_LS_ADDRESS`,
      `ANTIGRAVITY_TRAJECTORY_ID`, `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_SOURCE_METADATA`.
- [ ] Verify `--sandbox` syntax vs `agy` docs (boolean flag, default false). If
      valid, add bare `--sandbox` in plan mode to enforce read-only; keep
      `--dangerously-skip-permissions` for build/yolo. (#469 used `--sandbox enabled`
      which is likely wrong — a value on a boolean flag.)

## P1 — Model picker (real gap in ours)
- [ ] Wire `useAntigravityModels()` → `antigravityModelOptions` into the toolbar so
      the model picker lists real models (fallback list already returned by
      `list_antigravity_models`). Files: `ChatToolbar.tsx`,
      `toolbar/BackendModelPickerContent.tsx`, `toolbar/useToolbarDerivedState.ts`,
      `toolbar/toolbar-options.ts` (mirror grok/kimi wiring).

## P2 — Settings + new-session UX
- [ ] `components/preferences/panes/AntigravityPane.tsx`: status/version, auth
      state, source toggle (path only for now), default-model select. Register in
      `PreferencesDialog.tsx` nav + search.
- [ ] `GeneralPane.tsx`: Antigravity login/relogin row (opens terminal `agy` login;
      Google-account/browser) using `useAntigravityCliAuth`.
- [ ] `NewSessionModeModal.tsx` + `lib/session-defaults.ts`: antigravity as a
      new-session kind (yolo args, status hook).
- [ ] `OnboardingDialog.tsx`: antigravity readiness entry.

## P3 — Managed install (optional parity)
- [ ] Port `install_antigravity_cli` (`curl -fsSL https://antigravity.google/cli/install.sh
      | bash -s -- --dir <cli_dir>`) + `uninstall_antigravity_cli`; add managed-binary
      resolution + `antigravity_cli_source` 'jean' vs 'path' in `resolve_cli_binary`.
      Wire Settings install button + `CliReinstallModal`/`CliUpdateModal`.
      (Lower priority: Go binary, PATH-only already works.)

## P4 — Magic prompts + MCP
- [ ] Magic-prompt presets/auto-defaults so Antigravity is selectable for one-shot
      ops (we already have `execute_one_shot_antigravity` with `--json-schema`).
      Files: `MagicPromptsPane.tsx`, `useMagicPromptAutoDefaults.ts`, `MagicModal.tsx`,
      `ResolveConflictsDialog.tsx`.
- [ ] MCP injection: add `Backend::Antigravity` to `thread_mcp_config` merge in
      commands.rs and write `~/.gemini/config/mcp_config.json` (jean_mcp) — HOME-level
      (workspace-local has upstream bug #60).

## P5 — Tests + verify
- [ ] Add `backend-label.test` case + a model-select/deserialize test.
- [ ] `bun install && bun run typecheck && bun run lint` (catch remaining
      exhaustive-switch sites) → `cargo test` (jean-core already green).

## Keep (do NOT regress)
- stream-json streaming executor, cancel(exit 130), tool-call capture.
- prefix-only `is_antigravity_model`.
- system_context (RECAP + system prompt already included).

## Suggested order: P0 → P1 → P2 → P5, then P3/P4 if wanted.
