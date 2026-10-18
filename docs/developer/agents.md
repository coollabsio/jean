# Agents

Agents are persistent AI workers (Jean, the coordinator, plus agents the user
creates) that manage projects through the Jean MCP tools. They run on the
backend, so they keep working with no client open. The feature is experimental:
**Settings → Experimental → Agents** (`agents_enabled`, default off).

Code: `jean-core/src/agents/` (backend), `src/components/agents/` and
`src/services/agents.ts` (UI).

## Storage

`{app_data}/agents.db` (SQLite, `rusqlite` with `bundled`: FTS5 on, no system
SQLite). Migrations are a list in `agents/db.rs` (`MIGRATIONS`, tracked with
`PRAGMA user_version`). Add a new entry; never edit an applied one.

| Table | Purpose |
|---|---|
| `agents` | Definitions. Jean (`jean`, built-in) is seeded on every start. |
| `delegations` | "Session S works for agent A". `origin_session_id` = the agent session that sent the work. Status: `active`, `waiting`, `done`, `failed`, `cancelled`. |
| `events` | Queued updates for an agent (`delegation`, `schedule`, `approval`, `message`). `target_session_id` = where it goes; empty = a new task. |
| `tasks` | One row per task session (background work): status, one-line result, archive state. |
| `notifications` | `notify_user` messages (inbox, toast). |
| `wakes` | One row per wake-up, for the hourly budget (`max_wakes_per_hour`). |
| `schedules` | One-shot (`every_secs` NULL) and repeating wake-ups. |
| `approvals` | Destructive MCP calls that wait for the user. |
| `memories` + `memories_fts` | Rules, facts, open work. `agent_id` NULL = shared. FTS5 kept in sync by triggers. |

All functions in `db.rs` take a `&Connection`, so tests use an in-memory
database. Runtime code uses `agents::with_db(app, |conn| ...)`.

## Agent sessions: chat and tasks

Agent sessions are normal Jean sessions under reserved worktree IDs that have
no worktree record. Each agent has two:

| Worktree ID | Holds |
|---|---|
| `__jean_agent__` / `__agent_<id>__` | The chat with the user (current chat + archived old chats) |
| `__agent_tasks_<id>__` | Task sessions: one per schedule run, agent request, or follow-up without an origin |

Both run in the agent's scratch folder: `{app_data}/jean-agent` or
`{app_data}/agents/<id>`. The chat never gets schedule runs or agent requests;
the user sees task results through `notify_user` (inbox + toast) and the Tasks
tab.
`agents::is_agent_worktree_id()` keeps their session indexes out of orphan
cleanup, and `resolve_worktree_path` in the MCP core maps them to the scratch
folder.

`agents::system_prompt_for()` adds the agent prompt (role, how the
infrastructure works, other agents, memory within a size budget) to every run
in an agent worktree, for every backend. Chat sessions also get the end of the
previous chat (`carry_over`); task sessions are told the user does not read
them and to use `notify_user`.

## The loop (`agents/engine.rs`)

```
send_chat_message (MCP, caller = agent chat or task session)
  └─ record_delegation ──► delegations(active, origin = caller)
chat:done / chat:error / chat:cancelled (in-process listener)
  └─ mark delegations and tasks of that session ──► check_after = now + 2s
tick (every 5s, or nudge())
  ├─ delegation checks ──► event with target = origin session
  ├─ task checks ──► task status + one-line result
  ├─ due schedules ──► event without target
  ├─ deliver (not paused, within the hourly budget):
  │    ├─ target set ──► "[Jean agent update]" into that session when idle
  │    │                 (an archived old chat forwards to the current chat)
  │    └─ no target ──► new task session (max 2 running per agent)
  └─ maintenance (every 60s):
       ├─ chat ≥ 40 messages and idle 10 min ──► new chat, old one archived,
       │                                        end saved as carry_over
       └─ finished tasks: archive after 3 days, delete 30 days later
```

Test overrides (environment, for isolated test servers only):
`JEAN_AGENT_CHAT_ROTATE_MESSAGES`, `JEAN_AGENT_CHAT_ROTATE_IDLE_SECS`,
`JEAN_AGENT_TASK_ARCHIVE_SECS`.

- Wake-ups never run in Plan mode (`wake_execution_mode`), because Plan mode
  blocks the Jean MCP tools.
- New chat and task sessions get the default execution mode saved once
  (`ensure_session_mode`). Sessions without metadata otherwise load as Plan.
- At startup, active delegations are checked once, so runs that ended while
  Jean was closed are still reported.

## MCP tools (`agents/mcp.rs`)

Agent-only tools: `schedule_create/list/cancel`, `memory_save/search/update/forget`,
`message_agent`, `notify_user` (emits `agents:notification` for the toast),
`task_list`. The caller is identified by `JEAN_MCP_SESSION`. Codex threads
get it per thread through a config override
(`jean_mcp_config::codex_session_config_override`), because the persistent
`~/.codex/config.toml` entry only has a fixed label.

**Approval gate:** `delete_worktree`, `permanently_delete_worktree`,
`push_worktree`, `merge_pull_request` and `create_pull_request` called from an
agent session are stored in `approvals` and not run. When the user approves,
`jean_mcp_core::run_approved_tool` runs the same call, and the result goes to
the agent as an event. The gate is in `call_tool`, so it works for every
backend and does not depend on the prompt.

**Agent-to-agent:** `message_agent` adds a `message` event (no target, so it
runs as a task of the target agent) with `reply_to_agent` and
`reply_to_session`. On delivery, a delegation (sender → target task, origin =
sender's session) is recorded, so the answer returns to the session that asked.
`MAX_AGENT_HOPS` limits chains.

## Commands

Registered in `http_server/dispatch.rs` (`AGENT_COMMANDS`, served by
`dispatch_agents_command`), so native IPC and web access both work:
`list_agents`, `get_agent_details`, `create_agent`, `update_agent`,
`delete_agent`, `decide_agent_approval`, `cancel_agent_schedule`,
`save/update/delete/export_agent_memory`, `mark_agent_notifications_read`,
`get_agent_workdir`.
Changes emit `cache:invalidate` with key `agents`.

## Stack size note

`dispatch_command` and the MCP `run_tool` are very large async functions. In
debug builds their poll frames are large enough to overflow tokio's default
2 MiB worker stack. Keep new arms out of them: put new command groups in a
separate function and call it through `Box::pin(...)`, as the agents commands
do. All entry points use `jean_core::build_tokio_runtime()` (8 MiB worker
stacks).
