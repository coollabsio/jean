# Magic prompts: choose execution surface (Jean Chat vs native CLI terminal)

## Problem

Every AI-triggered action is hardwired to the Jean Chat headless path. The
`magic_prompt_backends` preference only picks *which CLI binary Jean spawns
headlessly* — it is not a surface picker. There is no way to run a magic prompt,
an "Investigate Failure", or a new branch's first session in a real Claude/Codex
terminal.

Two execution paths exist today and only the first is ever reachable from a
magic prompt:

- **Path 1 — Jean Chat (headless):** `sendMessage.mutate(...)` -> jean-core
  spawns the CLI headless and streams JSON into ChatWindow.
- **Path 2 — Terminal (PTY):** `createSession({ primarySurface: 'terminal',
  terminalCommand, terminalCommandArgs })` -> `terminalStore.addTerminal` ->
  `start_terminal`.

## Locked decisions

- Prompt delivery: **positional arg at spawn** (user choice), with documented
  fallbacks where argv is unsafe or unsupported.
- Scope: **all magic prompts + new worktree/branch default surface**.
- Default stays `chat` everywhere, so existing behavior is unchanged until the
  user opts in.

## Verified facts (do not re-derive)

- `claude "prompt"` and `codex "prompt"` launch the interactive TUI and
  auto-submit the prompt.
- `cursor-agent "prompt"` starts interactive with the instruction.
- `opencode --prompt "..."` only **pre-fills** the TUI box; it does not submit
  (anomalyco/opencode#3937). Needs a trailing `\r` via `terminal_write`.
- `grok` / `kimi` / `pi` / `commandcode` positional-prompt support is
  **UNVERIFIED** — treat as write-fallback backends.
- PTY spawn shapes (`jean-core/src/terminal/pty.rs`):
  - Unix: `sh -l -i -c '<single-quote-escaped joined string>'` (`:113-130`,
    escaping at `jean-core/src/platform/process.rs:8`). Multi-line safe.
  - Windows native exe: direct `CommandBuilder` argv (`:268-272`). Safe.
  - Windows `.cmd`/`.bat` shim: `cmd.exe /C <cmd> <args>` (`:260-264`).
    **NOT safe** for multi-line prompts or prompts containing `& | ^`.
  - WSL: `wsl.exe ... -- <cmd> <args>` direct argv (`:208-213`). Safe.
- `terminal_write(terminal_id, data)` already exists:
  `jean-core/src/terminal/commands.rs:189`.
- Surface-preference precedent: `default_new_session_kind`
  (`src/types/preferences.ts:1263`), consumed only by
  `NewSessionModeModal.tsx:273-291` for Cmd+T.
- A new worktree's first session is `Session::default()` with
  `primary_surface: None` (`jean-core/src/chat/types.rs:975, 1012-1019`) — this
  is why a new branch always lands in Jean Chat.

## Excluded from scope (with reasons)

- [ ] **Housekeeping prompts stay chat-only**: `session_naming`,
      `context_summary`, `commit_message`, `pr_content`. These never open a chat
      session today — commit goes through `startCommitJob`
      (`useGitOperations.ts:526`), naming/summary run inside jean-core
      (`chat/commands.rs:1605`, `:7705`). They are already instant and
      invisible; routing them through a watched TUI plus a file round-trip is
      strictly slower for the same string. Not part of the reported symptom.
      No surface key for these.
- **Code review is NOT excluded** — see section 2b. It gets a terminal surface
  via the temp-file result bridge, keeping `ReviewResultsPanel` fully populated.

## Progress

- **Section 1 (prefs plumbing): DONE AND FULLY VERIFIED.**
  - `bun run typecheck` exit 0; `bunx eslint` on all changed files exit 0.
  - `bunx vitest run src/types/preferences.test.ts src/services/preferences.test.ts`
    -> 43 -> 48 passing (5 new resolver tests added).
  - `cargo test --manifest-path jean-core/Cargo.toml` -> 1025 passed, 0 failed.
    No regressions from the `AppPreferences` or `pub(crate)` changes.
  - Adding the two fields broke 7 full-literal `AppPreferences` fixtures in
    `src/services/preferences.test.ts` — fixed. Any future field on
    `AppPreferences` will break the same 7 spots; they are not spread-based.
  - TS: `MagicPromptSurface`, `MagicPromptSurfaces` (11 keys),
    `DEFAULT_MAGIC_PROMPT_SURFACES`, `resolveMagicPromptSurface`, plus
    `magic_prompt_surfaces` + `default_magic_prompt_surface` on `AppPreferences`
    and `DEFAULT_PREFERENCES` (`src/types/preferences.ts`).
    **UNVERIFIED** — see blocker below.
  - Rust: `MagicPromptSurfaces` struct, the two `AppPreferences` fields, and
    `default_magic_prompt_surface()` (`jean-core/src/lib.rs`). Verified with
    `cargo check --manifest-path jean-core/Cargo.toml`.
  - No patch plumbing needed: `patch_preferences` (`lib.rs:3216`) is a shallow
    top-level merge over the serialized struct, so `#[serde(default)]` fields
    round-trip on their own. Note the shallow merge means the UI must send the
    whole `magic_prompt_surfaces` object, same as `magic_prompt_backends`.
  - `release_notes` joined the chat-only group: it is
    `invoke('generate_release_notes')` returning text into a dialog
    (`ReleaseNotesDialog.tsx:140`), same class as commit_message.

- **Section 2 (terminal launcher): DONE AND VERIFIED. Dispatcher still PENDING.**
  - New `src/lib/magic-prompt-terminal.ts`: `BACKEND_COMMANDS`,
    `YOLO_ARGS_BY_BACKEND`, `planPromptDelivery`, `buildMagicPromptCommandArgs`,
    `isWindowsShimCommand`, `launchMagicPromptTerminal`.
  - Pure decision logic is split from the store/IPC side so it is unit-testable:
    17 tests in `src/lib/magic-prompt-terminal.test.ts`, all passing.
  - `planPromptDelivery` takes `serverIsWindows` as a parameter rather than
    reading the platform module — the PTY runs on the Jean server, which may be
    a different OS than the client, and injection keeps it testable.
  - Three documented fallbacks from argv to PTY write: unsupported backend
    (grok/kimi/pi/commandcode), prompt over `MAX_ARGV_PROMPT_CHARS` (8000), and
    Windows `.cmd`/`.bat` shim carrying newlines or `& | ^ < >`.
  - Deduped: `NewSessionModeModal.tsx` now imports `BACKEND_COMMANDS` and
    `YOLO_ARGS_BY_BACKEND` from the launcher instead of declaring its own.
    Its 21 tests still pass.
  - STILL TO DO for section 3: `useMagicPromptRunner` dispatcher that picks
    between the existing `sendMessage.mutate` path and this launcher.

- **Section 3 (dispatcher): DONE AND VERIFIED.**
  - New `src/components/chat/hooks/useMagicPromptRunner.ts` exposing
    `tryRunInTerminal(...) => Promise<boolean>`. 9 tests passing.
  - **Deviation from the plan, deliberate.** The plan said to extract the chat
    path into the dispatcher. Built as a *guard* instead: `if (await
    tryRunInTerminal({...})) return`, leaving each call site's chat logic
    untouched. Restructuring two large hooks whose session-priming sequences are
    load-bearing bought no behavior and risked breaking the working path.
  - A failed terminal launch surfaces a toast and returns `true` (handled). It
    must NOT fall through to chat — a surprise headless run spends tokens the
    user did not ask for.
  - **Reuse catch:** `src/services/cli-binary.ts` already had
    `resolveBackendCliPath` / `bareCommandForBackend` / `preferResolvedCliCommand`.
    My `BACKEND_COMMANDS` duplicated its `BARE_BACKEND_COMMANDS`, so it was
    deleted and both the dispatcher and `NewSessionModeModal` now use
    `cli-binary`. This matters beyond tidiness: Jean-managed installs live under
    app data and are NOT on PATH, so launching a bare name would fail.

- **Section 4 (call sites): 3 of 7 DONE.**
  - `handleInvestigate` (all 6 investigate types, via `INVESTIGATE_SURFACE` map)
    and `handleInvestigateWorkflowRun` ("Investigate Failure") in
    `useInvestigateHandlers.ts`.
  - Guard placement matters and differs between the two:
    - `handleInvestigate`: guard sits *before* the chat-store priming block, so
      a terminal run does not leave a stray "sending" session behind. Required
      hoisting the `investigateBackend` computation above that block.
    - `handleInvestigateWorkflowRun`: guard sits *after* `setActiveWorktree` /
      `selectWorktree` / `expandProject` but *before* `createSession.mutate`, so
      the terminal opens in the worktree the user is switched to.
  - REMAINING: `handleReviewComments`, `handleResolveConflicts`,
    `handleResolvePrConflicts`, `handleFinalReview`, plus `handleReview`
    (code review, which routes through section 2b instead).

- **Section 2b (file bridge): core module DONE, wiring PENDING.**
  - New `jean-core/src/projects/review_terminal.rs`: result-path helpers,
    worktree-containment guard, terminal prompt builder, poll-based watcher with
    settle detection, cleanup. 11/11 unit tests pass via
    `cargo test --manifest-path jean-core/Cargo.toml review_terminal`.
  - `REVIEW_SCHEMA` promoted to `pub(crate)` so the prompt can embed it — a TUI
    has no `--output-schema` flag.
  - Polling, not `notify`: that crate is not a dependency and the file appears
    exactly once. Parse failures only become final once the file stops growing
    between polls, so a mid-write poll is not mistaken for malformed output.
  - STILL TO DO: thread `surface` through `start_review_job`, branch to the
    terminal path, spawn the watcher task, and route its outcome into
    `mark_completed` / `mark_failed`.

## Decision: no separate TUI selector (settled, do not revisit)

A global `magic_prompt_terminal_backend` in Settings/General was added and then
**reverted**. Reason: `magic_prompt_backends` already means "which CLI binary"
and that meaning is identical on both surfaces — spawned headless for chat, or
as a TUI for terminal. A second control would have created two places to set the
same thing, with no rule for which wins.

Final shape, all per-prompt in the Magic Prompts pane, nothing in General:

    Surface   [ Chat | Terminal ]   <- new
    Backend   [ Claude | Codex | ... ]   <- existing, = which CLI / which TUI
    Model     [ ... ]                    <- existing, filtered by backend
    Mode / Effort                        <- existing

`tryRunInTerminal` therefore takes `backend` from the caller (already resolved
via `resolveMagicPromptBackend`) and does NOT resolve its own.

## Known gap: model is not passed to terminal runs

`launchMagicPromptTerminal` currently ignores the model, so a terminal run uses
the CLI's own default instead of the model configured for that magic prompt.
Verified flags to wire up:
- `claude --model <name>`
- `codex -m/--model <name>`
- `opencode --model <provider/model>`
- cursor: model flag NOT verified — leave unset until confirmed.

Not a trivial pass-through: Jean's stored model ids carry decorations the CLIs
will not accept (`claude-opus-4-8[1m]` has a context-window suffix, opencode ids
are already `provider/model`-prefixed, codex has fast-variant splitting — see
`split_fast_model` in `jean-core/src/chat/codex.rs`). Needs a normalizer per
backend plus tests before wiring.

## Blocker

RESOLVED. bun is installed (`C:\Program Files\nodejs\bun.ps1`), `bun install`
ran (628 packages). TS is verifiable again.

Commands that work in this repo:
- `bun run typecheck`
- `bunx vitest run <paths>` — note `bun run test` is watch-mode vitest, so use
  `bunx vitest run` for one-shot runs.
- `bunx eslint <paths> --max-warnings 0`
- `cargo test --manifest-path jean-core/Cargo.toml [filter]`

## Plan

### 1. Preferences plumbing

- [ ] `src/types/preferences.ts`: add `MagicPromptSurface = 'chat' | 'terminal'`,
      `MagicPromptSurfaces` (one key per terminal-capable op, mirroring
      `MagicPromptBackends` at `:1062`), `DEFAULT_MAGIC_PROMPT_SURFACES`
      (all `null`), and `default_magic_prompt_surface: MagicPromptSurface`
      defaulting to `'chat'` (add near `:2374`).
- [ ] `src/types/preferences.ts`: add `resolveMagicPromptSurface(surfaces, key,
      fallback)` mirroring `resolveMagicPromptBackend`.
- [ ] `jean-core/src/lib.rs`: add `#[serde(default)] pub magic_prompt_surfaces:
      MagicPromptSurfaces` and `default_magic_prompt_surface` alongside
      `magic_prompt_backends` (`:225`); add the struct + `default_*` fn near
      `:687`; extend the `AppPreferences::default()` literal near `:2590`.
- [ ] Confirm the preferences patch/merge path round-trips the new fields
      (`src/services/preferences.ts` + its tests).

### 2. Terminal launcher for magic prompts

- [ ] New `src/lib/magic-prompt-terminal.ts`:
  - `MAGIC_PROMPT_ARGS_BY_BACKEND`: `claude|codex|cursor -> [prompt]`,
    `opencode -> ['--prompt', prompt]`.
  - `NEEDS_SUBMIT_KEY`: `opencode` (pre-fill only).
  - `WRITE_FALLBACK_BACKENDS`: `grok`, `kimi`, `pi`, `commandcode` (unverified
    argv support).
  - `MAX_ARGV_PROMPT_CHARS = 8000` — longer prompts use the write path.
  - `isArgvUnsafeCommand(command)` — true for `.cmd`/`.bat` on Windows when the
    prompt is multi-line or contains `& | ^` (see pty.rs finding above); forces
    the write path.
  - `runMagicPromptInTerminal({ prompt, backend, command, mode, worktreeId,
    worktreePath, label })`:
    1. build args = yolo args (when `mode === 'yolo'`, reuse
       `YOLO_ARGS_BY_BACKEND` — lift it out of `NewSessionModeModal.tsx:71` into
       this module and import it back there, do not duplicate)
       + `--session-id <uuid>` for claude
       + prompt args (argv path only)
    2. `createSession({ primarySurface: 'terminal', backend, terminalCommand,
       terminalCommandArgs, terminalLabel })`
    3. `terminalStore.addTerminal(...)` + `uiStore.setSessionPrimarySurface` +
       `setSessionTerminalId` + `chatStore.setActiveSession`
       (mirror `NativeCliSessionsModal.tsx:322-412`)
    4. write path / submit key: on `TerminalStartedEvent` for this terminal id,
       `invoke('terminal_write', { terminalId, data: prompt + '\r' })` (write
       path) or `data: '\r'` (submit-key path).
- [ ] Resolve the CLI binary path the same way `NewSessionModeModal` does
      (`use*CliStatus().data.path`, falling back to the `backendCommands` map at
      `:60`). Extract that map rather than re-declaring it.

### 2b. Temp-file result bridge (code review in a terminal)

Goal: run code review in a real TUI while `ReviewResultsPanel`, review history,
finding counts and the `--fix` follow-up keep working exactly as today.

Verified target shape (`jean-core/src/projects/commands.rs:9460-9485`):
`ReviewResponse { summary: String, findings: Vec<ReviewFinding>,
approval_status: String }`. The headless path already ends in "model emits JSON
-> serde deserializes", so the bridge reuses the same deserialization and the
same completion path (`mark_completed` + `update_review_session_entry`,
`:10199-10211`). Nothing downstream changes.

- [ ] Rust: `start_review_job` gains a `surface: Option<String>` arg. When
      `"terminal"`, skip the `spawn_blocking(run_review_with_ai)` branch
      (`:10167-10194`) and instead reserve a result path + start a watcher.
- **Ownership split (decided).** Rust cannot spawn the terminal: terminals live
  in the frontend Zustand store (`terminalStore.addTerminal`), and `start_terminal`
  only attaches a PTY to an id the store already minted. So:
  - Rust owns: session creation (already does, `:10096-10117`), result path,
    terminal prompt, CLI binary resolution (per-backend
    `resolve_cli_binary(app) -> PathBuf` exists for every backend, e.g.
    `claude_cli/config.rs:109`, `codex_cli/config.rs:97`), and the watcher task.
  - `StartReviewJobResponse` gains an optional `terminal_launch { command, args,
    session_id }`. The frontend sees it and creates the terminal through the
    normal `addTerminal` path.
  - Precedent: `prepare_backend_terminal_context`
    (`chat/context_instructions.rs:372`) already returns command args for the
    frontend to launch with. Same shape, so this is not a new pattern.
- [ ] Result path: `<app_data>/reviews/<review_run_id>.json`. Create the parent
      dir up front; never inside the worktree (must not pollute the user's diff
      — a review that dirties the tree it is reviewing is a self-inflicted bug).
- [ ] Terminal-variant prompt: the headless template inlines the diff via
      `{diff}` (`:10019-10031`). A terminal agent reads the worktree itself, so
      build a separate template: review `<current_branch>` against
      `<target_branch>`, then write JSON matching the `ReviewResponse` schema to
      `<result_path>`. Embed the full schema literally in the prompt.
      Keep `REVIEW_PROMPT` untouched for the headless path.
- [ ] Watcher: watch `<result_path>` for creation/write. On write, debounce,
      read, `serde_json::from_str::<ReviewResponse>`, then call the existing
      `mark_completed` + `update_review_session_entry` + `emit_review_job_update`
      so the panel populates identically to a headless run.
- [ ] Backstop signal: also resolve on `TerminalStoppedEvent` for the session's
      terminal id — but the watcher is primary, because an interactive TUI does
      not exit when the review finishes; the user keeps it open.
- [ ] Failure handling (locked): timeout, default ~15 min, configurable.
      On timeout **or** parse failure -> `mark_failed` with the raw file
      contents attached when the file exists, so the panel shows the error and
      the still-open TUI can be inspected. Never silently re-run headless.
- [ ] Clean up the result file and deregister the watcher on job
      completed / failed / cancelled, and on app shutdown.

### 3. Shared dispatcher

- [ ] New `src/components/chat/hooks/useMagicPromptRunner.ts` exposing
      `runMagicPrompt({ prompt, surfaceKey, backend, model, provider, mode,
      effort, worktreeId, worktreePath, sessionId? })`.
  - `surface === 'chat'` -> today's `sendMessage.mutate` block, extracted
    verbatim (including `setSessionBackend/Model/Provider`,
    `primeSessionSelection`, `buildMcpConfigJson`).
  - `surface === 'terminal'` -> `runMagicPromptInTerminal`, skipping all the
    chat-only session-state priming.
  - Surface resolution: `override?.surface ?? resolveMagicPromptSurface(prefs,
    surfaceKey, prefs.default_magic_prompt_surface ?? 'chat')`.

### 4. Route the call sites (7)

- [ ] `useInvestigateHandlers.ts:523` — `handleInvestigate` (issue / pr /
      security-alert / advisory / linear-issue / sentry-issue).
- [ ] `useInvestigateHandlers.ts:799` — `handleInvestigateWorkflowRun`
      ("Investigate Failure"). Keep the existing worktree-resolution logic at
      `:622-700`; only swap the send.
- [ ] `useInvestigateHandlers.ts:1013` — `handleReviewComments` (loops over
      prompts; keep the deliberate sequential `createSession` behavior noted at
      `:1044-1047`).
- [ ] `useGitOperations.ts:303` — `handleResolveConflicts`.
- [ ] `useGitOperations.ts:~370` — `handleResolvePrConflicts`.
- [ ] `useGitOperations.ts:459` — `handleFinalReview`.
- [ ] `useGitOperations.ts:995` — `handleReview` (code review). Resolve the
      surface pref and pass `surface` through to `start_review_job`; the Rust
      side (section 2b) decides between the headless runner and the terminal +
      file-bridge path. The frontend does NOT create the terminal itself here —
      `start_review_job` already owns session creation (`:10096-10117`).
- [ ] Extend `InvestigateOverride` (`useMagicCommands.ts:15`) with an optional
      `surface` so per-invocation pickers can override the pref.
- [ ] Push/pull conflict fallback (`useGitOperations.ts:680-686`) needs no
      change — it dispatches `magic-command: resolve-conflicts`, which now
      honors the resolve-conflicts surface pref automatically.

### 5. Preferences UI

- [ ] `MagicPromptsPane.tsx`: add `surfaceKey?: keyof MagicPromptSurfaces` to the
      config row type at `:147` and populate it on the rows that got a surface
      key (mirroring the `backendKey` entries at `:170-486`).
- [ ] Render a Chat / Terminal segmented control next to the existing backend
      picker (`:836-865` region), disabled with a tooltip for rows that are
      chat-only.
- [ ] `GeneralPane.tsx`: add the global `default_magic_prompt_surface` selector
      next to the existing `default_new_session_kind` control (`:4578`,
      handler at `:1416`).
- [ ] `preferences-search.ts`: register the new settings so they are findable.

### 6. New worktree / branch default surface

- [ ] Make worktree creation honor `default_new_session_kind` instead of always
      landing on the Rust-created default chat session.
- [ ] Reuse the working logic rather than duplicating it: on worktree-ready with
      auto-open, call `useUIStore.getState().openNewSessionModeModal({
      worktreeId, worktreePath, intent: 'default', origin })`. The auto-handler
      at `NewSessionModeModal.tsx:266-291` already dispatches chat / terminal /
      backend-terminal from that pref, including the `autoStartNew` bypass so no
      dialog flashes.
- [ ] Hook point: `useCreateWorktree.onSuccess` in `src/services/projects.ts:659`
      (and the `create_worktree_from_existing_branch` twin at `:825`) — but
      trigger only once the worktree flips from `pending` to `ready`, since
      `onSuccess` fires while creation is still in flight.
- [ ] Leave the Rust-side `Session::default()` alone; the terminal session is
      created *in addition*, and becomes the active one.

### 7. Verification

- [ ] Unit: `resolveMagicPromptSurface` fallback chain (key -> global -> 'chat').
- [ ] Unit: `magic-prompt-terminal.ts` arg building per backend — claude/codex
      positional, opencode `--prompt` + submit key, write-fallback backends get
      no prompt on argv.
- [ ] Unit: `isArgvUnsafeCommand` returns true for `claude.cmd` + multi-line
      prompt on win32, false for `claude.exe`.
- [ ] Unit: over-length prompt (> 8000 chars) takes the write path.
- [ ] Rust unit: a well-formed `<review_run_id>.json` deserializes into
      `ReviewResponse` and drives `mark_completed` to the same job state a
      headless run produces.
- [ ] Rust unit: malformed JSON -> `mark_failed` with raw contents attached,
      not a panic and not a silent success.
- [ ] Rust unit: watcher timeout -> `mark_failed`, watcher deregistered, result
      file cleaned up.
- [ ] Assert the result path is outside the worktree, so a terminal review never
      dirties the diff it is reviewing.
- [ ] Existing suites that must stay green: `useInvestigateHandlers.test.tsx`,
      `useGitOperations.test.tsx`, `MagicPromptsPane.test.tsx`,
      `NewSessionModeModal.test.tsx`, `preferences.test.ts`.
- [ ] Manual smoke (see review section below) — the argv/PTY interaction cannot
      be proven by unit tests alone.

## Review

_(fill in after implementation)_
