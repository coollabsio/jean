# Hermes Backend Integration

How Jean should integrate [Hermes Agent](https://hermes-agent.nousresearch.com/) as a first-class backend — including chat, profiles, and **cron / scheduled jobs**.

Related issue: [#277](https://github.com/coollabsio/jean/issues/277).

## Why Hermes is different

Hermes is not just another coding CLI that Jean spawns per turn.

| Concern | Claude / Codex / Grok (typical Jean backends) | Hermes |
| --- | --- | --- |
| Process model | Jean owns a child process (CLI / ACP host) | Hermes gateway is a long-lived daemon |
| Tools | Jean or CLI executes tools | Hermes executes tools inside its agent loop |
| Session resume | Backend-specific resume id | Responses API `previous_response_id`, named `conversation`, or `/api/sessions/*` |
| Scheduling | Jean `ScheduleWakeup` (session one-shot) + project auto-fix | Hermes gateway cron (`jobs.json` + Jobs API) |
| Isolation unit | Jean session / worktree | Hermes **profile** (`HERMES_HOME`) |
| Local models | Provider-dependent | Strong fit (DGX Spark, Qwen, etc.) via Hermes providers |

Implication: Jean should treat Hermes as an **HTTP control plane client** first, and as a PATH CLI second (install/status/cron CLI fallbacks). Do **not** reimplement Hermes cron inside Jean.

## Capability map

### Hermes API server (default `http://127.0.0.1:8642`)

Auth: `Authorization: Bearer $API_SERVER_KEY` (required).

| Surface | Path | Jean use |
| --- | --- | --- |
| Health | `GET /health`, `GET /health/detailed` | Connection + readiness |
| Capabilities | `GET /v1/capabilities` | Feature detection |
| Models (alias) | `GET /v1/models` | Cheap model id for OpenAI-compat clients |
| Model catalog | `GET /api/model/options` | Settings model picker |
| Chat completions | `POST /v1/chat/completions` (+ SSE, `hermes.tool.progress`) | Simple / legacy chat path |
| Responses | `POST /v1/responses` | Multi-turn with server-side history |
| Runs | `POST /v1/runs`, `GET …/events`, `POST …/stop`, `POST …/approval` | **Preferred chat path** for long agent turns |
| Sessions | `/api/sessions/*` | Native session list / fork / stream chat |
| Jobs (cron) | `/api/jobs*` | Scheduled work control plane |
| Skills / toolsets | `GET /v1/skills`, `GET /v1/toolsets` | UI discovery |

### Jobs API vs full cron surface (important gap)

Hermes **internal** `create_job()` supports:

`prompt`, `schedule`, `name`, `repeat`, `deliver`, `skills`, `model`, `provider`, `base_url`, `script`, `context_from`, `enabled_toolsets`, **`workdir`**, `no_agent`, `attach_to_session`.

But the **HTTP** Jobs API (as of Hermes main, July 2026) is thinner:

- **Create** body: `name`, `schedule`, `prompt`, `deliver`, `skills`, `repeat` only
- **Update** whitelist: `name`, `schedule`, `prompt`, `deliver`, `skills`, `skill`, `repeat`, `enabled`

Missing on HTTP (but available on CLI / agent `cronjob` tool): **`workdir`**, model/provider pins, scripts, `no_agent`, toolset limits, `context_from`.

**Jean policy:**

1. Prefer Jobs API for list / get / pause / resume / run / delete.
2. When create/update needs `workdir` (or other full fields), use local CLI:

   ```bash
   hermes [-p <profile>] cron create "<schedule>" "<prompt>" \
     --name "..." --workdir /abs/worktree/path --deliver local
   ```

3. Track an upstream Hermes PR to expand Jobs API create/update to the full `create_job` kwargs. Until then CLI is the correct full-fidelity path for worktree-bound jobs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Jean (UI + jean-core)                                       │
│  · Backend::Hermes chat sessions                            │
│  · Hermes settings (base URL, API key, profile, CLI)        │
│  · Jobs panel (list/create/pause/run)                       │
│  · Map worktree.path → cron workdir                         │
└───────────────┬───────────────────────────┬─────────────────┘
                │ HTTP (reqwest)            │ CLI (silent_command)
                ▼                           ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│ Hermes gateway + API server  │   │ hermes cron / profile    │
│  · /v1/runs + SSE            │   │  · full job create       │
│  · /api/jobs (partial CRUD)  │   │  · gateway install/start │
│  · profiles via /p/<name>/   │   └──────────────────────────┘
└──────────────────────────────┘
```

### Chat transport (recommended)

1. Ensure gateway is up (`GET /health`).
2. Create or reuse a Hermes session (`POST /api/sessions`) **or** use Runs with Jean session id correlation.
3. Preferred stream: `POST /v1/runs` then `GET /v1/runs/{id}/events` (SSE).
   - Map token deltas → `chat:chunk`
   - Map tool progress / function_call items → `chat:tool-use` / `chat:tool-result`
   - Map completion → `chat:done` + usage
   - Map stop → `POST /v1/runs/{id}/stop` on Jean cancel
   - Map approval wait → Jean permission UI + `POST …/approval`
4. Store Hermes resume id on Jean `Session` (`hermes_session_id` / `previous_response_id` / conversation key).
5. Stable memory scope: send `X-Hermes-Session-Key: jean:{project_id}:{worktree_id}:{session_id}` (independent of rotating transcript ids).

Fallback: OpenAI chat completions stream + `hermes.tool.progress` if Runs API is unavailable (`/v1/capabilities`).

### Execution modes

Hermes owns tools and approvals inside the gateway. Jean plan/build/yolo cannot map 1:1 to Claude permission modes.

| Jean mode | Hermes MVP behavior |
| --- | --- |
| plan | Prefer read-only instructions in system/instructions; if Hermes approval policy exists, keep interactive approvals |
| build | Normal agent tools; file edits allowed |
| yolo | Same as build unless Hermes has a bypass flag we can set per request |

Document unsupported nuances in UI rather than faking sandbox guarantees.

### Profiles

- Hermes profiles = isolated `HERMES_HOME` (config, memory, skills, **cron jobs**, gateway).
- Jean prefs: `hermes_profile` (empty = default `~/.hermes`).
- Multiplex: when gateway has `gateway.multiplex_profiles`, route as `/p/<profile>/…` and use **that profile’s** `API_SERVER_KEY`.
- Per-project optional override later: `Project.default_hermes_profile`.

### Worktree ↔ cron `workdir`

When creating a job from a Jean worktree:

- Set `workdir` to the worktree absolute path (CLI path until API supports it).
- Hermes then loads that tree’s `AGENTS.md` / `CLAUDE.md` / `.cursorrules` and runs tools with that cwd.
- **Serialization:** Hermes runs workdir jobs **sequentially** on the tick (process-global cwd). Jean UI should show this constraint; do not promise parallel worktree cron runs.

Store Jean metadata alongside the Hermes job id (Jean-side index optional):

```json
{
  "hermes_job_id": "a1b2c3d4e5f6",
  "project_id": "...",
  "worktree_id": "...",
  "profile": "default"
}
```

Do not patch `~/.hermes/cron/jobs.json` directly.

### Delivery of cron results into Jean

Hermes delivery targets today: `local`, messaging platforms, `origin`, etc. There is **no first-class `jean` delivery target**.

MVP delivery strategy:

1. Create jobs with `deliver: "local"` (files under `~/.hermes/cron/output/{job_id}/`).
2. Jean polls job status via Jobs API (`last_status`, `last_run_at`, errors).
3. Optional: on status change, toast + optional inject into a linked Jean session as a system/assistant note.
4. Later: Hermes webhook / custom delivery plugin, or Jean-side “pull last output” command.

Do not conflate with:

- **ScheduleWakeup** — Claude-only in-session delayed re-prompt (60s–1h), Jean-owned.
- **Auto-fix** — project issue scanner that creates worktrees; Jean-owned.

Hermes cron is for **recurring / detached agent (or script) work** while the Hermes gateway is running.

### Gateway lifecycle (when does Hermes start?)

**Default: do not start Hermes gateway when Jean starts.**

Match Jean’s other long-lived backends:

| Backend | Jean start behavior | When process starts |
| --- | --- | --- |
| OpenCode server | Not auto-started | `acquire()` on first OpenCode use (refcount) |
| Codex app-server | Not auto-started | `ensure_running()` on first Codex turn |
| Hermes gateway | **Not auto-started** | `ensure_gateway()` on first Hermes chat/jobs need, **or** optional pref |

**Why not always-on with Jean:**

1. **Cost** — Hermes is a full agent runtime (tools, providers, optional messaging). Most Jean users never select Hermes.
2. **Remote gateways** — `hermes_api_base_url` may point at an already-running host/DGX instance; Jean must not spawn a second local daemon.
3. **Missing config** — without `API_SERVER_ENABLED` + key + model setup, a forced start only produces errors at every launch.
4. **Cron should outlive Jean** — if the user depends on Hermes cron, the right host is Hermes’ own service (`hermes gateway install` / systemd / launchd), not “Jean is open.” Tying cron to Jean app lifetime is the wrong product model.

**Recommended policy:**

| Mode | Behavior |
| --- | --- |
| **Default** | Jean only probes `GET /health`. If down, UI shows “Hermes gateway not running” with Start / Open docs. |
| **On demand (chat)** | First Hermes chat or explicit “Start gateway” calls `ensure_gateway_running` → service start / detached `gateway run`, waits for health. |
| **Always-on (cron)** | **Install Hermes**, **Start gateway**, and job **create/resume** call `ensure_gateway_always_on` → `hermes gateway install` (+ start-on-login when available) and wait for API health. Install fails (with CLI present) if the gateway never becomes healthy. Cron and messaging adapters require Hermes to keep running without Jean. |
| **Optional pref** | `hermes_gateway_autostart: false` by default. When `true` **and** CLI is installed **and** base URL is loopback (not remote), Jean may start the local gateway shortly after app ready. Never autostart against non-local URLs. |
| **Remote base URL** | Jean never spawns a local daemon. Cron still needs that remote host’s gateway always up (`hermes gateway install` there). |

**Do not kill** a gateway Jean did not start (external/service-managed). Only stop Jean-spawned children on Jean quit if Jean owns the PID (same rule as managed OpenCode server).

### Provider auth (Claude / Codex / Grok / Portal)

**Policy: Hermes owns provider credentials. Jean does not copy Jean-backend tokens into Hermes.**

Hermes gateway + CLI already import / discover provider auth:

| Provider | Hermes behavior (sufficient for Jean) |
| --- | --- |
| Claude Code | Auto-reads `~/.claude/.credentials.json`; OAuth prefers Claude Code store |
| OpenAI Codex | Imports `~/.codex/auth.json` into `~/.hermes/auth.json` when present |
| xAI Grok | `XAI_API_KEY` in Hermes `.env`, or Hermes SuperGrok OAuth (`hermes auth add xai-oauth`) |
| Nous Portal / others | `hermes model` / `hermes setup --portal` |

Jean responsibilities only:

1. Ensure CLI/gateway when needed (`ensure_gateway_*`).
2. Detect Hermes-side readiness (`~/.hermes/auth.json` providers, `~/.hermes/.env` keys, or API `api_authenticated`).
3. Open `hermes model` for login when the user is not authenticated.
4. List models from the gateway (`/api/model/options`) and send `provider` + `model` on chat/jobs.

Do **not** implement Jean→Hermes credential mirroring for Claude, Codex, Grok, or other backends. If auth is missing, tell the user to run Hermes setup; the gateway will import disk auths where Hermes supports it.

## Preferences (snake_case, Pattern A)

| Field | Default | Meaning |
| --- | --- | --- |
| `hermes_api_base_url` | `http://127.0.0.1:8642` | API root (no trailing `/v1`) |
| `hermes_api_key` | `null` | Bearer token; never log |
| `hermes_profile` | `""` (default profile) | Profile name for CLI / `/p/` routing |
| `hermes_cli_source` | `path` | PATH hermes binary (Jean-managed install later) |
| `selected_hermes_model` | `hermes-agent` | Model alias advertised by Hermes |
| `hermes_gateway_autostart` | `false` | If true and base URL is loopback, Jean may start local gateway after app ready |

Gateway must already have `API_SERVER_ENABLED=true` and `API_SERVER_KEY` set for the API surface to be useful.

## Module layout

```
jean-core/src/hermes_cli/
  mod.rs
  config.rs      # binary resolve, prefs → connection config
  client.rs      # reqwest HTTP client (health, jobs, capabilities)
  types.rs       # job + status DTOs
  commands.rs    # dispatch-facing async commands

jean-core/src/chat/hermes.rs   # (phase 2) chat/runs streaming execution

src/types/hermes-cli.ts
src/services/hermes-cli.ts
```

Register every command in `http_server/dispatch.rs` (native + web access share this).

## Phased delivery

### Phase 0 — Control plane (this branch)

- [x] Design doc
- [x] Connection prefs + status (`check_hermes_status`: CLI installed + API health)
- [x] Jobs list / get / pause / resume / run / delete via API
- [x] Create job: API for basic fields; CLI when `workdir` / full fields required
- [x] TS types + React Query hooks
- [x] Unit tests for URL join, job DTO mapping, create routing
- [x] Install + gateway service (`install_hermes_cli` → official installer + `gateway install`)
- [x] PI-style auth: CLI login (`hermes model`) + credential detection
- [x] Model list for active subscription (`list_hermes_models` via `/api/model/options`)
- [x] Per-session model from Jean → Hermes request as `provider` + `model`

### Phase 1 — Chat backend MVP

- [x] `Backend::Hermes` in Rust + TS
- [x] `chat/hermes.rs` MVP chat completions (Runs + SSE can deepen later)
- [ ] Cancel, resume id, usage, tool progress
- [x] Toolbar / backend label / model picker from `/api/model/options`
- [ ] Settings connection form (base URL, key, profile)
- [ ] Capability-gated UI (if gateway old, degrade)

### Phase 2 — Cron UX

- [x] Jobs panel (Settings → Hermes: CLI install, gateway, model, jobs)
- [x] “Schedule from worktree” action pre-fills `workdir`
- [x] Last local output viewer
- [x] Link job ↔ worktree in Jean metadata (`hermes-job-index.json`)
- [ ] Unread / toast when a job finishes (global badge; panel already polls)

### Phase 3 — Depth

- [ ] Magic prompts one-shot via Hermes
- [ ] Approvals UI for run approval endpoint
- [ ] Multi-profile management in Jean
- [ ] Gateway install/start helpers
- [ ] Upstream Hermes Jobs API expansion for `workdir` et al.
- [ ] Optional Jean delivery target / webhook

## Security

- Hermes API grants **full tool access** (terminal included). Keys are high privilege.
- Default bind is loopback; if user exposes host/port, require explicit CORS + strong key.
- Never log `hermes_api_key` or Authorization headers.
- Prefer loopback base URLs in defaults; warn on non-local hosts in UI.
- Cron prompts are scanned by Hermes for injection patterns — still treat job create as privileged.

## Testing strategy

- Unit: client URL building, job serde, create API vs CLI routing when workdir set.
- Integration (optional): against a live local gateway when `HERMES_TEST_URL` + key set.
- UI: status shows disconnected vs ready; jobs list empty state.

## References

- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)
- Jean backend checklist: `AGENTS.md` → “Adding a New AI Backend”
- Jean schedulers to not confuse: `chat/wakeup.rs`, `auto_fix/scheduler.rs`
