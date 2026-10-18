# Muse Code backend: shared spec

Backend id: `muse`. Display label: "Muse". Binary: `muse` (Meta Muse Code CLI, verified 1.4.10).

All facts below were verified against the installed CLI (`~/.local/bin/muse`, 1.4.10) on 2026-10-18.

## Verified CLI facts

- Install: `curl -fsSL https://dev.meta.ai/install.sh | bash`. Env: `MUSE_INSTALL_DIR=<dir>` (default `~/.local/bin`), `MUSE_NO_MODIFY_PATH=1` (do not edit shell profiles). Installs a launcher `<dir>/muse` (bash script, self-updates in background) plus `<dir>/muse-bin-<version>`.
- Version: `muse --version` -> `Muse Code 1.4.10 (1.4.10-R6427.1)`.
- Auth: precedence `META_API_KEY` env, then stored key, then stored browser session. Stored credentials: `$XDG_CONFIG_HOME/muse/auth.json` (default `~/.config/muse/auth.json`), shape `{"schema_version":1,"providers":{"meta":{"api_key":"..."}}}` (browser session shape unknown: treat any non-empty `providers.meta` object as authenticated). Login: `muse login` (interactive browser flow, needs a terminal). API key: `muse auth set --api-key-stdin` (key on stdin). Logout: `muse logout`. No status command exists.
- Settings: `~/.config/muse/settings.json` (`schema_version: 1`). MCP servers live in its `mcp_servers` object (stdio: `command`,`args`,`env`; `streamable_http`: `url`,`headers`; plus `enabled`, `mode`).
- `-c key=JSONVALUE` sets one setting per run; unknown keys are refused. `run.developer_prompt` is a valid key: use it for Jean's system prompt (`-c run.developer_prompt=<json string>`). Do NOT use `run.system_prompt` (replaces Muse's own prompt).
- Reasoning effort: `none|minimal|low|medium|high|xhigh|max|ultra` (default high).
- Permission profiles (ids include the leading colon): `:read-only`, `:ask-me`, `:auto-review`, `:unrestricted`.
- `--provider echo` gives a deterministic offline provider (reply `echo: <prompt>`). Use it in tests. `serve` also reads `provider` from settings.json.

## Transport: MSP (`muse serve`), JSON-RPC 2.0, one JSON message per line on stdio

Schema: `/tmp/muse-test/msp.schema.json` (from `muse schema generate-json-schema`). Real echo transcript: `/tmp/muse-test/msp-echo-transcript.jsonl`. Probe scripts: `/tmp/muse-scripts/msp_probe.py`, `/tmp/muse-scripts/msp_rpc.py`.

Host launch: `muse serve [--provider X] [--model M] --trust-workspace --disable-request-user-input [-c run.developer_prompt="..."] [--disable-sandbox]` with cwd = worktree.

Sequence (all ids client-minted UUIDv7 for `commandId`):
1. request `initialize` `{clientInfo:{name:"jean",version}}` -> wait for result.
2. notification `initialized` `{}`.
3. New session: request `session/start` `{commandId, workspaceRoot, permissionProfile, approvalMode?, modelId?}` -> `result.session.sessionId` (store as Jean `muse_session_id`). Existing: request `session/resume` `{commandId, sessionId, permissionProfile, excludeItems:true}`.
4. request `turn/start` `{commandId, sessionId, input:[{type:"text",text}, {type:"image",base64Data,mediaType}...], reasoningEffort?}` -> result `{turnId, disposition:"started"}`.
5. Read notifications until `turn/completed` `{terminal:"completed"|"failed"|"cancelled", error?:{kind,message,retryable}, usage?}`.
6. Cancel: request `turn/cancel` `{commandId, sessionId, turnId?}`. Steer (optional): `turn/steer`.

Notifications to parse (others ignore):
- `item/started`, `item/updated`, `item/completed`: `params.item` with `itemId`, `kind`, `status` (`inProgress|completed|failed|cancelled|rejected|timedOut`), `revision`.
  - `agentMessage`: `text` (full text on completed). `messagePhase` may be `finalAnswer`.
  - `reasoning`: `text` and/or `summary[]`.
  - `toolCall`: `tool` (name), `args` (verbatim JSON string, parse leniently), `callId`, `visibleOutput` (result text), `failureReason`, `displayLabel{active,done,neutral}`, `patchSummary`.
  - `userMessage`, `reminderChild`, `hookRun`, `compaction`, `subagent`, `workflow`, others: ignore for Jean content (reminderChild items are Muse-internal background helpers).
- `item/delta`: `{itemId, field?, delta}`. `field` absent or `"text"` -> append to that item's text (agentMessage -> chat chunk; reasoning -> thinking). `"summary.N"` -> reasoning summary (thinking). `"output"` -> toolCall visibleOutput stream.
- `session/tokenUsage`: `usage{inputTokens,outputTokens,cachedTokens,reasoningTokens,cacheReadTokens?}`; `turn/completed.usage` same shape.
- Server requests `approval/request` `{approvalId, currentRequirementId, availableChoices:[{choiceId,decision,label,scope}], toolName, subject}`: answer with request `approval/decide` `{commandId, sessionId, approvalId, choiceId, requirementId: currentRequirementId}`. Auto-pick choice with `decision:"approved"` in build/yolo, `"denied"` in plan. `userInput/request`: disabled by flag; if one arrives, answer with a JSON-RPC error.

## Jean execution mode mapping

| Jean mode | permissionProfile | approvalMode | serve flags |
|---|---|---|---|
| plan (default) | `:read-only` | (omit) | none |
| build | `:ask-me` | `allowAll` | none |
| yolo | `:unrestricted` | (implied allowAll) | `--disable-sandbox` |

Plan mode: Muse has no plan tool. Mirror the Kimi/Antigravity synthetic plan approach (final agent text becomes the plan, `waiting_for_plan`).

## Effort mapping

Jean effort value passes through when it is one of `none|minimal|low|medium|high|xhigh|max|ultra`; otherwise omit.

## Models

Jean model ids use the prefix `muse/`: `muse/default` (server default, omit `--model`/`modelId`), `muse/muse-spark-1.2`. `is_muse_model(m) = m.starts_with("muse/")`. Default preference `selected_muse_model = "muse/default"`. `list_muse_models` returns at least those two; it may add rows from MSP `model/list` (`result.models[].modelId/displayLabel/isDefault`) when that call succeeds (it returns an empty list when not signed in).

## One-shot (magic prompts)

`muse exec --json --permission-profile :read-only [--model M] [--output-schema <tmpfile>] [-c run.developer_prompt=...] "<prompt>"` in the target dir. Output JSONL records: final text is `payload.text` of the line with `payload_type == "run.terminal.completed"`. Failure: `run.terminal.failed` / non-zero exit. `--output-schema` works with the meta provider only; also wrap prompt with strict-JSON instructions and use tolerant JSON extraction (like `extract_json_object` in `chat/kimi.rs`).

## Contract between Rust and frontend (names must match exactly)

- Rust `Backend::Muse` serializes as `"muse"`. TS `Backend` union gets `'muse'`.
- Session field: `muse_session_id: Option<String>` (Rust `Session`, metadata structs; TS `muse_session_id?: string | null`), mirroring `antigravity_session_id` everywhere.
- Preferences (snake_case, `#[serde(default)]`): `selected_muse_model: String` (default `"muse/default"`), `muse_cli_source: String` (`"jean"` | `"path"`, default same as Antigravity's default).
- Commands (registered in `jean-core/src/http_server/dispatch.rs`, functions in `jean-core/src/muse_cli/commands.rs`, re-exported from `crate::muse_cli`):
  - `check_muse_cli_installed` -> `MuseCliStatus {installed, version: Option<String>, path: Option<String>}`
  - `detect_muse_in_path` -> same shape as Antigravity's detect result
  - `check_muse_cli_auth` -> `MuseAuthStatus {authenticated, error: Option<String>, timedOut?}` (camelCase like Antigravity's)
  - `list_muse_models` -> `Vec<MuseModelInfo {id, label, isDefault?}>`
  - `get_muse_install_command` -> `{command, args, description}`
  - `install_muse_cli {version?}`, `uninstall_muse_cli`, `update_muse_cli`
  - `login_muse_cli` -> opens a terminal running `<binary> login` (reuse the existing terminal-login helper other backends use)
  - Keep the same serde casing as the Antigravity equivalents.
- MCP: `muse_cli::mcp::get_mcp_servers` reads `~/.config/muse/settings.json` `mcp_servers`; wire into the existing MCP discovery the same way Antigravity is wired.
- Frontend services file: `src/services/muse-cli.ts`, types `src/types/muse-cli.ts`, settings pane `MusePane.tsx`, icon `MuseIcon.tsx`.

## Template

Copy the Antigravity integration (commit `72976b60` plus every later file that mentions `antigravity`) for all wiring. Use `jean-core/src/chat/kimi.rs` (detached JSON-RPC host per turn, `--jean-kimi-acp-host`) as the template for `jean-core/src/chat/muse.rs` (`--jean-muse-msp-host`).
