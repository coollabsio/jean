# Add ASD-STE100 to Jean's global system prompt

- [x] Locate the synchronized Rust and TypeScript default prompts.
- [x] Add the exact ASD-STE100 instruction to both defaults.
- [x] Run focused tests and consistency checks.
- [x] Search GitHub issues and discussions for related reports.
- [x] Record review results and test steps.

## Review

- Added the exact instruction to the TypeScript preference default, the shared
  Rust preference default, and Claude's synchronized Rust fallback.
- Added assertions for both Rust prompt paths. The focused Rust test passed: 2
  tests, 0 failures.
- The prompt edit matches Prettier output, and the scoped diff check passed.
- The full Rust format check remains blocked by unrelated existing differences
  in `claude.rs`, `opencode.rs`, `codex_cli/commands.rs`,
  `http_server/server.rs`, and `projects/git_status.rs`.
- GitHub: no fully fixed, related, or similar issue or discussion was found for
  ASD-STE100, Simplified Technical English, or the global system prompt.

## How to test

- Open Settings → Magic Prompts and reset the global system prompt to its
  default. Confirm the ASD-STE100 sentence is the first instruction.
- Start a new Claude session and a new non-Claude session. Ask each agent to
  explain a technical topic. Confirm that each response uses short, direct,
  Simplified Technical English.

---

# Create a missing directory when adding a project (2026-08-09)

- [x] Trace the add-project and initialize-project path handling.
- [x] Add a failing regression test for a missing selected directory.
- [x] Create the directory before Jean validates the selected project path.
- [x] Run focused tests and quality gates.
- [x] Search GitHub issues and discussions and record the results.

## Design

- Keep directory creation in the Rust project boundary so native and web access
  use the same behavior.
- Create all missing parent directories before git-repository validation. Keep
  the existing error and Git initialization flow after the directory exists.
- Reject an existing file path as before.

## Review

- Root cause: `init_project` created a missing directory, but `add_project`
  validated the path first. A selected path that no longer existed stopped with
  `Path does not exist`, so the existing Git initialization flow did not open.
- `add_project` now creates the selected directory and all missing parents before
  Git validation. A non-repository directory then follows the existing Git init
  flow. `init_project` uses the same directory helper.
- The new regression test failed before the helper was added. Both directory
  tests now pass. Rust Clippy and `git diff --check` also pass.
- The full Rust format check remains blocked by unrelated existing format
  differences in Claude, OpenCode, Codex CLI, HTTP server, Jean MCP, and Git
  status files.
- GitHub: [#323](https://github.com/coollabsio/jean/issues/323) is similar because
  it concerns adding projects through web access, but this change does not fully
  fix that older client-versus-server selection report. No fully fixed or
  related issue or discussion was found.

## How to test

- In New Project, select or enter a path whose last directory does not exist.
  Confirm Jean creates it and continues to the Git initialization flow.
- Complete Git initialization. Confirm Jean adds the project and the new path is
  a directory with a `.git` repository.
- Select an existing file as the project path. Confirm Jean rejects it and does
  not replace the file.

---

# Fix hanging agent status

- [x] Trace Codex agent lifecycle events from parser to UI.
- [x] Add a failing regression test for a finished or interrupted agent.
- [x] Implement the smallest lifecycle fix and cover other backends if shared.
- [x] Run focused tests and `bun run check:all`.
- [x] Search GitHub issues and discussions for related reports.
- [x] Record review results and test steps.

## Review

- Root cause: Codex v2 emits `started`, `interacted`, and `interrupted` sub-agent
  activity, but it has no completed activity kind. Jean treated every unresolved
  agent as interrupted when a normal parent turn completed, so finished agents
  stayed at `0/N`.
- Fix: Treat a normal parent turn completion as completion for unresolved Codex
  agents. Preserve interrupted state when the assistant message is cancelled.
- Regression test: The focused Vitest file passes all 3 tests. The new assertion
  failed before the production change with `interrupted` instead of `completed`.
- Quality gates: TypeScript typecheck, ESLint, Prettier, and `git diff --check`
  passed. `bun run check:all` then stopped at Rust format checks because existing,
  unrelated Rust files do not match this toolchain's formatter output.
- GitHub: issue #590 is similar and discusses agent lifecycle inference. No exact
  issue or discussion for normal Codex completion was found.

## How to test

- Start a Codex turn that spawns an agent and let the parent turn finish normally.
- Confirm the Agents widget changes from `0/1` to `1/1` and shows Completed.
- Start another turn, spawn an agent, then cancel the parent turn.
- Confirm the agent shows Interrupted instead of Completed.

---

# Migrate Gemini backend to Antigravity CLI

- [x] Confirm the official Antigravity CLI install, auth, headless, session, model, permission, MCP, and structured-output contracts.
- [x] Replace the persisted backend identity and preferences with migration-safe Antigravity names.
- [x] Replace Gemini install, update, remove, PATH detection, version selection, authentication, model, and MCP commands with official `agy` behavior.
- [x] Replace the Gemini ACP engine with Antigravity `stream-json`, conversation resume, execution modes, cancellation, recovery, and tool-event parsing.
- [x] Migrate all one-shot and Magic Prompt routes to native `--json-schema` structured output.
- [x] Rename all frontend types, services, settings, labels, icons, models, and user-facing text to Antigravity CLI.
- [x] Register all renamed native and web-access commands and preserve old persisted data through aliases or migration fallbacks.
- [x] Update tests and documentation. Keep only intentional Gemini migration references.
- [x] Run focused tests, `bun run check:all`, format checks, and an installed-binary smoke test.
- [x] Search Jean GitHub issues and discussions for fixed, related, and similar reports.

## Migration design

- Use the official native `agy` binary. Jean-managed installs use the official release manifest and verified SHA-512 archives; System PATH resolves `agy` first and the documented `antigravity` executable as a compatibility alias.
- Use `agy -p --output-format stream-json` for chat and long operations. Persist the returned `conversation_id` and resume with `--conversation`.
- Map Plan to `--mode plan`, Build to `--mode accept-edits`, and Yolo to `--mode accept-edits --dangerously-skip-permissions`.
- Use `--output-format json --json-schema` for one-shot operations. Do not keep the Gemini ACP transport or its unsupported assumptions.
- Read MCP servers from Antigravity's documented global and workspace `mcp_config.json` files.
- Keep legacy `gemini` values only as deserialization and preference migration inputs. Do not show Gemini as a selectable backend.

---

# Antigravity extended capabilities

- [x] Parse the documented nested `tool_info` structure, including parameters, output, and tool errors.
- [x] Convert documented `subagent_info` entries into Jean agent activity tool calls.
- [x] Parse terminal result states and treat ERROR, INVALID, WAITING, and RUNNING as incomplete failures.
- [x] Treat CANCELED and INTERRUPTED terminal states as cancellation.
- [x] Import the documented latest workspace conversation from `last_conversations.json`.
- [x] Pass Jean effort levels to Antigravity.
- [x] Use Antigravity's terminal sandbox for Plan and Build.
- [x] Make Build usable in headless mode by auto-approving tools inside the sandbox; keep Yolo unsandboxed and fully approved.
- [x] Confirm that plugins, skills, rules, hooks, MCP, and subagents load automatically through the Antigravity harness.
- [x] Keep TUI-only features in the Login terminal instead of presenting non-working Jean controls.
- [x] Validate incomplete terminal states on the Windows attached-process path.
- [x] Capture headless soft-denial diagnostics and return a clear permission error.
- [x] Mark Antigravity subagents complete when the parent result completes successfully.
- [x] Ignore the model-list progress header instead of presenting it as a model.
- [x] Remove obsolete Gemini ACP tasks from this file.
- [x] Route persisted Antigravity run logs through the Antigravity stream parser.
- [x] Add a regression test that reconstructs assistant text from real Antigravity NDJSON.

## Review

- The official headless event schema now maps directly to Jean tool and agent UI data.
- The latest conversation for a workspace is discoverable from `~/.gemini/antigravity-cli/cache/last_conversations.json`; the complete remote history remains available only through `/resume`.
- Custom agents are usable by Antigravity and can spawn automatically. A persistent Jean `--agent` selector is not added because Jean sessions do not currently have an agent-profile preference contract.
- Plugins, skills, rules, hooks, projects, artifacts, `/diff`, `/fork`, `/rewind`, `/tasks`, and the full permission manager are Antigravity harness or TUI capabilities. They do not require duplicate Jean implementations to work during agent execution.
- Root cause of the empty completed response: live Antigravity streaming worked, but history reload used Jean's generic Claude-style run-log parser. That parser ignored Antigravity `step_update` and `result` events. The persisted conversation ID was correct and unrelated to the missing content.

---

## Shared backend settings redesign (2026-08-08)

- [x] Apply the Gemini section hierarchy, separators, spacing, and field cards to Claude, Codex, OpenCode, Cursor, PI, Command Code, Grok, and Kimi.
- [x] Add a shared responsive source-choice component instead of duplicating backend markup.
- [x] Replace source dropdowns with Jean-managed and System PATH cards for every backend that supports both sources.
- [x] Show each detected PATH binary and version in its source card.
- [x] Preserve backend-specific install, update, remove, authentication, model, reasoning, sandbox, and steering behavior.
- [x] Keep Cursor on its supported PATH-only flow while applying the shared section and card styling.
- [x] Add shared component and layout regression tests.

## Backend source action placement (2026-08-08)

- [x] Move each managed-install Uninstall action below the System PATH card.
- [x] Keep the source cards full width on desktop and mobile.

## Antigravity migration review (2026-08-08)

- Replaced the unreleased Gemini backend identity, settings, services, commands, session metadata, chat routing, Magic Prompts, MCP discovery, and all user-facing backend text with Antigravity CLI.
- Jean-managed installs now use Google's native installer and stable release manifest. System PATH detects `agy` and the documented executable alias. The current official manifest exposes one stable version, so the version chooser shows that version.
- Chat uses `stream-json`, persists `conversation_id`, resumes with `--conversation`, streams tool/thinking/usage events, runs detached on Unix, and uses Jean's process registry for cancellation.
- One-shot work uses Antigravity's native `--json-schema` and `structured_output` instead of Gemini prompt-only JSON repair.
- Legacy `gemini` backend, preference, CLI-source, and session fields migrate to Antigravity on read.
- Intentional Gemini text remains only for Gemini model names, Antigravity's documented `.gemini` configuration path, the official Gemini migration reference, and legacy migration aliases.
- Upstream interface limits: headless mode has no interactive approval or user-question surface, no in-turn steering API, no documented native-history file schema, and no MCP health command. Jean does not show false support for these features.
- Verification: TypeScript typecheck, ESLint, Rust compile, Clippy with warnings denied, 35 focused frontend tests, focused Rust Antigravity tests, and `git diff --check` passed. The full quality command stops only because the unchanged `src-server/src/main.rs` does not match the active formatter's trailing-newline output.
- Official binary smoke test: verified Antigravity CLI 1.1.11 flags for stream JSON, JSON Schema, conversations, modes, permissions, and models. The unauthenticated model check returned the documented sign-in message, which Jean detects.
- GitHub: [#175](https://github.com/coollabsio/jean/issues/175) is related but not fully fixed because it requests the old Gemini CLI. [#189](https://github.com/coollabsio/jean/issues/189) is a similar closed Gemini request. [#37](https://github.com/coollabsio/jean/issues/37) and [#432](https://github.com/coollabsio/jean/issues/432) are related but not fixed. No Antigravity or Gemini CLI discussion was found.

### How to smoke test

- Open Settings → Antigravity CLI. Test Jean managed install, version selection, Remove, System PATH, Refresh, Login, and Relogin.
- Sign in in the terminal, return to Settings, and confirm Installed, Authenticated, and account model options.
- Start Plan, Build, and Yolo sessions. Confirm Plan creates an approval card, Build follows configured permissions, and Yolo auto-approves.
- Cancel a long turn, close and reopen Jean during another long turn on macOS/Linux, and confirm the run log can be recovered.
- Send a second message and confirm the same Antigravity conversation continues.
- Set Antigravity for session naming, Save Context, commit, PR content, review, and release notes. Confirm each structured result is accepted.
- Add a server to `.agents/mcp_config.json` or `~/.gemini/config/mcp_config.json` and confirm it appears in Jean.

---

# Fix Antigravity effort and MCP integration (2026-08-08)

- [x] Add failing frontend tests that require Adaptive, Low, Medium, and High effort for Antigravity.
- [x] Route Antigravity selections through `effortLevel` and `agy --effort low|medium|high`.
- [x] Add failing Rust tests for Antigravity global MCP JSON installation.
- [x] Add Antigravity to Jean MCP and Agent Browser MCP automatic installers.
- [x] Make Antigravity MCP activation behavior honest: configured servers load automatically; do not claim unsupported runtime health.
- [x] Run focused frontend and Rust tests, quality gates, and an installed-CLI contract smoke test.
- [x] Search GitHub issues and discussions and record the review and smoke-test steps.

## Review

- Antigravity now uses its native effort contract only: Adaptive omits the flag; Low, Medium, and High pass `--effort low|medium|high`. Claude token-budget choices are not shown.
- Jean MCP and Agent Browser MCP can now be merged safely into `~/.gemini/config/mcp_config.json`, including onboarding and manual setup UI.
- Configured Antigravity MCP servers are shown as automatic and cannot be falsely disabled per session because `agy` has no documented runtime MCP override.
- Verification passed: 58 focused frontend tests, 17 focused Antigravity Rust tests, TypeScript, ESLint, Clippy with warnings denied, and `git diff --check`.
- `bun run check:all` reached the existing Rust formatter gate and stopped on unrelated pre-existing formatting differences in Claude, OpenCode, Codex CLI, HTTP server, and git-status files.
- GitHub: [#175](https://github.com/coollabsio/jean/issues/175) is related but not fully fixed because it requests Gemini CLI. [#211](https://github.com/coollabsio/jean/issues/211) is related unified MCP management work. [#430](https://github.com/coollabsio/jean/issues/430) is similar adaptive-thinking work. [#432](https://github.com/coollabsio/jean/issues/432) is similar Windows MCP work. No exact Antigravity issue or discussion was found.

## How to test

- Select Antigravity in chat. Open reasoning settings and confirm only Adaptive/Default, Low, Medium, and High appear.
- Send one turn at each explicit level and inspect the run/process log for `--effort low`, `--effort medium`, or `--effort high`. Adaptive must omit `--effort`.
- Open Settings → MCP Servers, enable Jean MCP, and use the one-click installer. Confirm `~/.gemini/config/mcp_config.json` contains `mcpServers.jean` or `mcpServers.jean-dev`.
- Install Agent Browser MCP and confirm `mcpServers.agent-browser` is in the same Antigravity config.
- Restart Jean and Antigravity, then send a prompt that requires one of the configured MCP tools. Confirm its tool call and result appear in chat.

---

# Handle Antigravity tool calls (2026-08-09)

- [x] Inventory real Antigravity `tool_info` names and parameter casing from persisted NDJSON.
- [x] Add failing renderer tests for Antigravity file, command, search, web, browser, agent, and task tools.
- [x] Normalize Antigravity tool names and PascalCase inputs to Jean's common renderers.
- [x] Preserve useful generic rendering for native Antigravity tools without a dedicated widget.
- [x] Run focused parser/UI tests and quality gates.
- [x] Search GitHub issues and discussions; record review and smoke-test steps.

## Review

- Root cause: Antigravity emits snake_case names such as `run_command`, `view_file`, and `write_to_file`, with PascalCase parameters such as `CommandLine`, `AbsolutePath`, and `TargetFile`. Jean's shared renderer knew similar tools but not these exact names or keys.
- File, edit, command, grep, glob, directory, web-search, and URL tools now use Jean's dedicated common renderers.
- Browser, image, terminal, knowledge-base, task, inbox, notification, and subagent tools now use a readable native Antigravity fallback instead of the unhandled warning.
- Verification passed: 77 focused UI tests, TypeScript, ESLint, and `git diff --check`.
- GitHub: [#573](https://github.com/coollabsio/jean/issues/573) and [#263](https://github.com/coollabsio/jean/issues/263) are similar unhandled-tool reports. No exact Antigravity issue or discussion was found.

## How to test

- Ask Antigravity to read and write a file, search the repository, and run a command. Confirm the rows show Read, Write/Edit, Grep/Glob, and Bash without an unhandled suffix.
- Ask Antigravity to search the web or read a URL. Confirm the row shows Web Search or Web Fetch with the query or URL.
- Use an Antigravity browser, task, subagent, terminal, or knowledge-base operation. Confirm it has a human-readable label and expandable details.

## 2026-08-09 — Antigravity selectable everywhere
- [x] Default backend (Settings General + project General) offers Antigravity when installed
- [x] Magic Prompts backend/model/effort + auto-defaults preset for Antigravity
- [x] Backend/model picker, MagicModal, ResolveConflicts, onboarding, search, MCP panes
- [x] Chat hooks: routing, effort, plan approval, hydration, labels, non-steerable queue
- [x] Rust: default_model_for_backend, jean_mcp_core backend lists, checkpoints, handoff, run_log plan injection
- [x] Verified: typecheck, eslint, clippy (lib), 2043 frontend tests, antigravity+module Rust tests
# Keep backend switch indicator on the changed prompt (2026-08-09)

- [x] Trace the persisted per-prompt backend data and reproduce the delayed separator.
- [x] Add a failing regression test for a prompt whose backend changed before its model metadata caught up.
- [x] Render the separator from the exact backend stored on the run.
- [x] Run focused tests and quality gates.
- [x] Search GitHub issues and discussions, then record results and test steps.

## Review

- Root cause: each run already stored its exact backend, but loaded user messages
  discarded that field. The separator inferred the backend from the model. A
  backend change could therefore use stale model metadata and appear one prompt
  late even though the correct backend handled the prompt.
- User messages now keep the run backend. Live optimistic messages also receive
  the selected backend. Old history without this field still uses model inference.
- The regression test failed with no separator before the fix and now passes.
- Verification passed: 37 focused frontend tests, 22 run-log Rust tests,
  TypeScript, ESLint, Rust compilation, and `git diff --check`.
- GitHub: no fully fixed, related, or similar issue or discussion was found.

## How to test

- Send a prompt with Codex, switch to Claude, and send the next prompt. Confirm
  `Codex → Claude` stays directly above that first Claude prompt.
- Send another Claude prompt. Confirm the separator does not move or repeat.
- Reload the session. Confirm the separator stays above the same prompt.

---
