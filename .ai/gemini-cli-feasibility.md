# Gemini CLI support in Jean: feasibility report

Date: 2026-08-08

## Decision

Jean can add Gemini CLI as a full chat backend. The best transport is Gemini CLI ACP over stdio, not terminal scraping and not one-process-per-turn `stream-json`.

The result can reach near-parity with Jean's Kimi and Grok integrations. It cannot reach exact parity on the first release because Gemini CLI has open ACP defects and no public custom JSON Schema output flag.

Recommendation: proceed only as a staged integration. Start with an ACP proof of concept and acceptance tests. Do not start product UI work until session restore, plan approval, permission events, and process recovery pass against the stable Gemini CLI release.

## Sources and checked version

- Stable package: `@google/gemini-cli` 0.54.4, published 2026-08-07: https://www.npmjs.com/package/@google/gemini-cli
- Stable release: https://github.com/google-gemini/gemini-cli/releases/tag/v0.54.4
- Source inspected at `cf22ac7e86f3dcf528e3ae591fec1c03090a49f8` (2026-08-07): https://github.com/google-gemini/gemini-cli/tree/cf22ac7e86f3dcf528e3ae591fec1c03090a49f8
- ACP documentation: https://geminicli.com/docs/cli/acp-mode/
- Headless output documentation: https://geminicli.com/docs/cli/headless/
- CLI reference: https://geminicli.com/docs/cli/cli-reference/
- Authentication: https://geminicli.com/docs/get-started/authentication/
- Session management: https://geminicli.com/docs/cli/session-management/
- Planning tools: https://geminicli.com/docs/tools/planning/
- MCP: https://geminicli.com/docs/tools/mcp-server/
- Checkpointing: https://geminicli.com/docs/cli/checkpointing/

The requested WebSearch tool was not available. I used current official documentation, the official repository, the npm registry, release metadata, and issue records instead.

## Transport choice

### 1. ACP over stdio — recommended

Gemini CLI ACP has the main interfaces that Jean needs:

- `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, and `session/cancel`.
- Streaming assistant text, thought chunks, tool calls, tool updates, and permission requests.
- Session modes: `default`, `auto_edit`, `yolo`, and optional `plan`.
- Runtime model selection through `session/set_model` (currently marked unstable in ACP).
- Image, audio, embedded context, and MCP server capabilities.
- Token usage in prompt response metadata.
- A proxied file-system service, which gives the host control of file access.

This matches Jean's existing detached ACP host design for Kimi and Grok. Jean should add a Gemini-specific adapter and reuse the detached-host lifecycle pattern, not copy a complete backend.

### 2. `--output-format stream-json` — fallback only

This output has `init`, `message`, `tool_use`, `tool_result`, `error`, and `result` events. It is good for one-shot magic prompts and as an emergency chat fallback. It is less suitable for normal Jean chat because it has no live host permission protocol, no in-turn user question protocol, and no stateful process control.

### 3. Native terminal — optional companion

Jean can also offer a native Gemini terminal session. Gemini has `--resume`, `--list-sessions`, and a project-scoped history store. This must not replace the ACP chat integration.

## Jean capability matrix

| Jean capability | Gemini CLI capability | Result and required work |
|---|---|---|
| Install, update, uninstall | Official npm package, Homebrew, MacPorts; Node 20+ | Full. Jean can manage npm like Kimi. PATH mode is also possible. Check macOS, Windows, Linux, and WSL. |
| Installed/version status | `gemini --version` | Full. Use a short timeout and `silent_command()`. |
| Authentication | Google OAuth, Gemini API key, Vertex AI, gateway; ACP advertises four auth methods | Full with work. Use ACP `authenticate` or open the native login terminal. A simple non-interactive `auth status` command does not exist, so Jean must validate selected settings plus a safe API/ACP initialization. |
| Google account entitlement | Native CLI owns OAuth and quotas | Likely full. Jean launches the official CLI and does not copy OAuth tokens. ACP is an official IDE integration surface. Validate this with a real Google account before release. |
| Main chat streaming | ACP `agent_message_chunk` | Full. Map to `chat:chunk`. |
| Thinking display | ACP `agent_thought_chunk` | Partial/risky. The event exists, but Gemini issue #20977 reported that some models did not emit it. Treat thoughts as optional. |
| Tool calls and results | ACP `tool_call` and `tool_call_update`; diff content and locations | Full with normalization. Map Gemini tool kinds and raw names to Jean names. Issue #21783 can produce an orphan update when permission is required. The adapter must synthesize a pending tool row from the permission request. |
| Ordered content blocks | ACP preserves text, thought, tool, diff, and result updates | Full with an ordered accumulator similar to Grok/Kimi. |
| Cancellation | ACP `session/cancel` | Full while the process is alive. Detached-host socket cancellation is still required for restart-safe Jean operation. |
| Steering a running turn | No ACP steer method; a second prompt aborts the current prompt | Not supported. Jean must disable steer for Gemini and queue the next prompt, or implement abort-then-send with clear UI text. Do not present this as true steer. |
| Resume by backend session ID | ACP `session/load`; CLI `--resume` | Supported but release-gated. Open issues #27913 and #28693 report lost context and failed crash recovery. Jean must keep its own transcript and test stable releases. |
| Survive Jean restart | Not provided by stdio alone | Full with Jean work. Use a detached Gemini ACP host on Unix. Keep Windows as non-survivable until a tested host design exists, as Jean does for other ACP backends. |
| Plan mode | Native `plan` approval mode, `enter_plan_mode`, `exit_plan_mode`, plan file | Full with work. Map Jean plan to Gemini `plan`. Handle `exit_plan_mode` through ACP permission UI and convert the plan file/content to Jean's plan approval shape. Do not auto-approve it in plan mode. |
| Build mode | Native `auto_edit` | Full. Map Jean build to `auto_edit`. This auto-approves edit tools but still asks for shell and other actions. |
| YOLO mode | Native `yolo` | Full. Map Jean yolo to `yolo`. |
| Fine permission UI | ACP `session/request_permission`, allow once/always, reject once/always | Full with work. Persist pending requests in Jean and respond through the detached host. Keep canonical tool IDs and arguments. |
| Ask-user questions | Gemini has an `ask_user` tool, but current ACP configuration explicitly excludes it | Not supported through ACP 0.54.4. Jean can only use a text-question fallback after the turn ends. Do not show Gemini as supporting Jean's structured in-turn questions unless upstream exposes this tool in ACP. |
| Plan approval after app restart | ACP host can keep the reverse request open | Feasible, high risk. The host must persist request metadata and accept a later Jean response. Test app close/reopen while approval is pending. |
| Images | ACP advertises image input and accepts inline base64 | Full. Reuse Jean image processing and send ACP image blocks. |
| Text files and directories | ACP resource links, embedded context, Gemini file tools | Full. For files outside the worktree, either embed content or handle ACP file access permission. |
| PDF/audio | Gemini read tool and ACP audio support | More than Jean currently needs. Keep out of the first scope unless the common attachment model supports it. |
| Project/custom/global prompts | `GEMINI.md`, context files, and `GEMINI_SYSTEM_MD` override | Full with care. Do not replace the built-in system prompt by default. Prefer a generated Jean context file or prepend Jean instructions to the prompt. If `GEMINI_SYSTEM_MD` is used, first export/compose the built-in prompt so Gemini tool instructions remain intact. |
| Linked-project, issue, PR, advisory, Linear context | Gemini accepts text, file resources, images, and MCP | Full through Jean prompt assembly. No Gemini-specific blocker. |
| Model list and selection | ACP returns available models; CLI has `auto`, `pro`, `flash`, `flash-lite` and concrete IDs | Full. Prefer ACP-discovered models plus CDN fallback. Model access varies by auth type. |
| Reasoning/effort | Gemini supports `thinkingBudget` for older families and `thinkingLevel` for Gemini 3; ACP does not expose a standard effort setter | Partial. First release should use `adaptive/default` only. Later, generate a per-run settings override with model-family-safe values. Do not map Jean effort labels blindly. |
| Usage per turn | ACP prompt result includes input/output token counts and per-model usage; stream JSON has aggregate stats | Full for tokens. Cost can be unknown for OAuth/free plans. Quota status is mainly `/stats`, not a clean public status command. |
| MCP discovery and execution | Stdio, SSE, and Streamable HTTP; resources and OAuth | Full. Discover `~/.gemini/settings.json`, project `.gemini/settings.json`, and ACP session MCP entries. Use Gemini CLI's allow/exclude policy and health/status commands where stable. |
| Per-session MCP toggles | ACP `session/new/load` accepts MCP servers; CLI settings support allow/exclude | Full. Pass only enabled servers to ACP. Ensure env-secret redaction matches Gemini rules. |
| Magic prompts | Headless JSON and stream JSON exist | Partial. Gemini has no public custom JSON Schema flag. Use strict JSON prompts plus tolerant extraction and validation, as Jean does for Kimi. Add one repair pass. Disable only operations that cannot pass schema tests. |
| Session naming, summary, PR, commit, review, conflicts, release notes | General one-shot model work | Full after strict-JSON validation. Code review needs the same multi-backend result contract and background job design as current Jean. |
| Checkpoints/undo | Gemini has shadow-git checkpoints, disabled by default, controlled in settings | Optional. Jean does not need this for backend parity. Do not silently enable or expose Gemini restore in the first release. It relates to Jean issue #37. |
| Native CLI history picker | Project-scoped JSONL sessions and `--list-sessions`/`--resume` | Full with work. Parse the stable local store only if the format is tested. Prefer the CLI list command when it has a machine-readable form; current documented output is text. |
| Terminal attention notification | No checked equivalent to Codex `notify` | Partial. A Jean terminal wrapper can watch process output, but it is less reliable. Keep this out of the first release or mark it unsupported. |
| Web access transport | Jean owns WebSocket dispatch | Full. Every new Tauri command must also be in `jean-core/src/http_server/dispatch.rs`. ACP continues on the server host. |
| Windows no-console behavior | CLI is Node-based | Full with Jean platform work. Use `silent_command()` for background checks and correct `.cmd` resolution. |
| Provider profiles | Gemini API key, Vertex AI, Google OAuth, gateway | Feasible but not identical to Jean provider profiles. First release should use the CLI's selected auth. Add explicit provider UI only after auth tests. |
| Extensions, skills, agents, hooks | Gemini supports all four | Optional. Gemini should first consume Jean's attached skill text and normal context. Native Gemini extensions/skills can be discovered later. |

## Main gaps and risks

### Release blockers

1. **ACP resume reliability.** Gemini advertises `loadSession`, but open reports show session context loss and failed mid-turn persistence:
   - https://github.com/google-gemini/gemini-cli/issues/27913
   - https://github.com/google-gemini/gemini-cli/issues/28693

2. **Permission tool lifecycle.** A permission request can arrive before a normal pending tool event:
   - https://github.com/google-gemini/gemini-cli/issues/21783

3. **No custom output schema flag.** The Gemini team closed the request without a plan to add it:
   - https://github.com/google-gemini/gemini-cli/issues/13388

4. **No true steering.** ACP offers prompt and cancel, not in-flight steer. Jean must disable the steer affordance for this backend.

5. **No structured in-turn user questions.** The Gemini source explicitly adds `ask_user` to excluded tools when `--acp` is active, even though the ACP permission conversion code knows the confirmation type. Jean must use an end-of-turn text fallback or wait for upstream support.

6. **Auth readiness is not a single command.** Jean needs a safe ACP initialization probe and clear states for installed, configured, authenticated, quota-limited, and failed.

### Non-blocking differences

- Thinking summaries are model-dependent and can be absent.
- Gemini reasoning controls do not map directly to Jean's common effort levels.
- Cost data can be unavailable for Google OAuth and free quota.
- Native terminal attention has no verified event interface.
- Gemini checkpoint restore is outside Jean's common chat model.

## Recommended delivery stages

### Stage 0: acceptance probe, no product UI

Build a test-only ACP client or Rust integration harness. It must prove:

- Google OAuth and API-key authentication.
- New session and two-turn memory.
- Kill, restart, `session/load`, full history replay, and memory recall.
- Text, thought-optional, tool, diff, and tool-result ordering.
- Allow/reject tool permission. Verify that `ask_user` is absent and that a text-question fallback is usable.
- Plan file, exit-plan approval, rejection feedback, and mode switch.
- Image input.
- MCP stdio and HTTP server use.
- Cancel during model output and during a tool.
- Stable 0.54.4 on macOS, Windows, and Linux.

If resume fails, do not ship ACP resume as supported. Either pin a fixed minimum Gemini version or use Jean-managed transcript injection for recovery and label it as a new Jean session.

### Stage 1: minimum useful Jean backend

- Install/status/auth.
- ACP chat with plan/build/yolo.
- Streaming text, optional thought, tools, permissions, cancellation, sessions, attachments, models, and usage.
- Strict-JSON one-shot support for naming, summary, PR, commit, and review.
- Settings, onboarding, toolbar, persistence, web dispatch, tests, and user documentation.
- No true steer, structured in-turn question UI, checkpoint UI, terminal attention, custom provider UI, or native extension management.

### Stage 2: parity improvements

- Detached crash recovery after upstream resume tests pass.
- Native terminal history import and resume.
- Per-model reasoning settings.
- MCP health and OAuth detail UI.
- Optional Gemini checkpoint integration and terminal attention.
- Native Gemini skills/extensions only if user demand is clear.

## Architecture recommendation

- Add `Backend::Gemini` and `gemini_session_id` to the Rust and TypeScript session contracts.
- Add `jean-core/src/gemini_cli/` for install, status, auth, config, and MCP discovery.
- Add `jean-core/src/chat/gemini.rs` for ACP mapping.
- Reuse or extract only the small, proven common parts of the Kimi/Grok ACP host: JSON-RPC transport, reverse permission request routing, detached log/socket lifecycle, and ordered content accumulation.
- Keep Gemini-specific mode names, model discovery, auth, attachments, session replay, and tool normalization inside the Gemini module.
- Use the CLI's native plan mode. Convert its plan approval to Jean's standard `ExitPlanMode` presentation.
- Use strict prompt + JSON extraction for magic prompts. Do not claim schema enforcement.
- Feature-gate Gemini behind a minimum tested CLI version. Start with stable 0.54.4 only if Stage 0 passes; otherwise require the first fixed stable version.

## Estimate

This is not a small backend addition. A staff-level estimate is:

- Stage 0 research harness: 2–4 engineering days.
- Stage 1 complete backend: 2–4 weeks, including Rust, React, persistence, web dispatch, all magic prompts, tests, and documentation.
- Stage 2 parity work: 1–3 additional weeks, with part of the schedule dependent on upstream ACP fixes.

The main cost is not the ACP parser. It is the complete Jean integration surface and the verification of auth, restart recovery, permissions, planning, MCP, magic prompts, web access, and all platforms.

## Related Jean issues and discussions

- **Related / target feature:** https://github.com/coollabsio/jean/issues/175 — open request for official Gemini CLI support.
- **Similar / duplicate:** https://github.com/coollabsio/jean/issues/189 — closed as a duplicate of #175.
- **Related, not fixed by this work:** https://github.com/coollabsio/jean/issues/37 — undo/revert request that cites Gemini checkpoint restore.
- No matching Jean GitHub discussions were found.

## Final recommendation

Proceed with a Stage 0 ACP acceptance probe. Gemini CLI is capable enough for a serious Jean backend, and ACP is now much better aligned with Jean than the older headless-only interface. Do not commit to full release parity until the stable CLI passes resume and permission lifecycle tests. Ship the first version with explicit limits: no steer, no structured in-turn questions, optional thinking, strict-JSON rather than schema-enforced magic prompts, and no checkpoint or terminal-attention UI.
