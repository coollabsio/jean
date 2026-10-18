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
| `schedules` | One-shot, interval (`every_secs`), cron, and event routines. |
| `approvals` | Destructive MCP calls that wait for the user. |
| `memories` + `memories_fts` | Rules, facts, open work. `scope` is `agent` (private), `shared` (cross-agent working memory), or `user` (facts about the user). `agent_id` NULL for shared and user. Superseded rows stay but drop out of search and prompts. FTS5 kept in sync by triggers. |
| `memory_changes` | Audit of create, update, forget, and supersede (before and after text, who did it). |
| `journal` + `journal_fts` | Dated history for one agent, including a short copy of a chat when it rotates. |

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
infrastructure works, other agents, selected skills, memory within a size
budget) to every run in an agent worktree, for every backend. Chat sessions
also get the end of the previous chat (`carry_over`); task sessions are told
the user does not read them and to use `notify_user`.

## Per-agent run configuration

Each agent can set `backend`, `model`, `effort`, `thinking_level`, and
`skills`. Any field left unset (`NULL`, or `[]` for skills) means the current
defaults: the same backend, model, and reasoning a new chat session would use
from user and project preferences. Existing `agents.db` rows stay on those
defaults. Migration v3 adds the columns; do not edit v1 or v2.

| Field | Stored as | Unset means |
|---|---|---|
| `backend` | `claude`, `codex`, `opencode`, `cursor`, `pi`, `commandcode`, `grok`, `kimi`, `antigravity`, or NULL | Session and user default backend |
| `model` | Model id string, or NULL | Preference model for the resolved backend |
| `effort` | `off`, `adaptive`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`, or NULL | No effort override |
| `thinking_level` | `off`, `adaptive`, `think`, `megathink`, `ultrathink`, or NULL | No thinking override |
| `skills` | JSON array of `{name, path, backend?}`, default `[]` | No extra skills |

`create_agent` takes the fields directly. `update_agent`'s patch uses a
missing field for "leave it", JSON `null` for "clear back to the default", and
`skills: []` to clear skills. Both commands go through
`dispatch_agents_command` in `jean-core/src/http_server/dispatch.rs`. Native
IPC calls that same function via `dispatch_core_command`; there is no separate
`generate_handler!` entry for agent commands.

The engine applies the fields in three places:

- New task sessions and rotated chats are created with the agent's backend.
  An empty home chat (no messages yet) is stamped the same way when the agent
  is created, updated, or listed, so the chat toolbar shows the choice.
- Wake-ups pass `backend`, `model`, `effortLevel`, and `thinkingLevel` on
  `send_chat_message`. A set backend with an unset model also passes that
  backend's preference model, so a stale model from another backend is not
  sent. Sessions that already have messages keep their stored backend; the
  wake still uses the agent's current values for that turn.
- Cursor has no Build mode. A Cursor wake uses Yolo instead of the usual
  Build fallback, because Plan mode blocks the Jean MCP tools.

### Skills

Skills are the files Jean already discovers per backend (`list_*_skills` in
`src/services/skills.ts`). At most 32 are stored. The least invasive way to
apply them is the marker chat already appends when a skill is attached:

```
[Skill: /path/to/SKILL.md - Read and use this skill to guide your response]
```

OpenCode inlines the file from that marker. Other backends are told to read
it. The marker is written into the agent system prompt, which every backend
already receives on every agent run, and the same markers are appended to
engine wake messages so OpenCode inlines the skill on each wake. Skill files
are not copied or rewritten.

## The loop (`agents/engine.rs`)

```
send_chat_message (MCP, caller = agent chat or task session)
  └─ record_delegation ──► delegations(active, origin = caller)
chat:done / chat:error / chat:cancelled (in-process listener)
  └─ mark delegations and tasks of that session ──► check_after = now + 2s
tick (every 5s, or nudge())
  ├─ delegation checks ──► event with target = origin session
  ├─ task checks ──► task status + one-line result
  ├─ due schedules (one-shot, interval, cron) ──► event without target
  │    event routines are queued by listeners, not by this tick
  ├─ deliver (not paused, within the hourly budget):
  │    ├─ target set ──► "[Jean agent update]" into that session when idle
  │    │                 (an archived old chat forwards to the current chat)
  │    └─ no target ──► new task session (max 2 running per agent)
  └─ maintenance (every 60s):
       ├─ chat ≥ 40 messages and idle 10 min ──► new chat, old one archived,
       │                                        end saved as carry_over, shorter
       │                                        copy stored as a journal entry
       └─ finished tasks: archive after 3 days, delete 30 days later
```

Test overrides (environment, for isolated test servers only):
`JEAN_AGENT_CHAT_ROTATE_MESSAGES`, `JEAN_AGENT_CHAT_ROTATE_IDLE_SECS`,
`JEAN_AGENT_TASK_ARCHIVE_SECS`. `JEAN_AGENT_CLOCK_FILE` points at a file whose
contents are a positive unix timestamp; `db::now()` returns that instead of the
wall clock so a cron routine can be moved onto its next slot during a local
run. Leave it unset in normal use.

- Wake-ups never run in Plan mode (`wake_execution_mode`), because Plan mode
  blocks the Jean MCP tools. Cursor wakes use Yolo instead of Build
  (`wake_execution_mode_for`).
- When the agent has a backend, model, effort, or thinking level, the wake
  passes those on `send_chat_message`. Selected skills are appended to the
  wake message with the chat skill marker.
- New chat and task sessions get the default execution mode saved once
  (`ensure_session_mode`). Sessions without metadata otherwise load as Plan.
- At startup, active delegations are checked once, so runs that ended while
  Jean was closed are still reported.

## Schedules

Migration v4 adds `cron`, `timezone`, `event`, and `paused` to `schedules`,
plus `schedule_event_keys` for event dedup. Do not edit v1–v3. Existing rows
keep `cron`, `timezone`, and `event` NULL and `paused` 0, so one-shot
(`every_secs` NULL) and interval schedules behave as before.

| Kind | Stored as | Next run |
|---|---|---|
| One-shot | `every_secs`, `cron`, and `event` NULL; `next_run_at` set | Fires once, then `active=0` |
| Interval | `every_secs` ≥ 300 | `next_run_at = fired_at + every_secs` |
| Cron | 5-field `cron` plus an IANA `timezone` | Next match strictly after the fire time, in that zone |
| Event | `event` set; `next_run_at` is 0 and is not a clock time | When the event happens |

`paused=1` keeps the row but the engine skips it. Delete is the existing
cancel (`active=0`). A paused agent still skips every schedule.

### Cron

Five fields: `minute hour day-of-month month day-of-week`. `*`, lists, ranges,
steps, and English month/day names are accepted. `?` is rejected. When both
day-of-month and day-of-week are restricted, a date matches if either field
matches (standard cron). The timezone is stored on the schedule (the UI
defaults to the browser zone; an omitted MCP timezone means UTC). Names that
differ only by case still resolve.

Next-run calculation walks local time in that zone:

- A match is strictly after the previous instant, so the slot that just fired
  is not chosen again.
- Spring-forward gaps (the missing hour) are skipped. `30 2 * * *` on the US
  spring-forward day runs the next day at 02:30.
- Fall-back overlap hours are real twice. The earlier offset is next, then the
  later offset.
- If Jean was closed, a due cron fires once and then jumps to the next match
  after the actual fire time. Missed slots are not replayed.

Validation rejects an expression whose successive runs are closer than 300
seconds, including a DST transition that would squeeze two matches together.
That is the same 5-minute floor as `every_secs`. `*/5 * * * *` is allowed;
`*/4` and `* * * * *` are not. Errors name the field or the gap.

### Events

Event routines wake through the same queue as cron: `fire_event_schedules`
inserts a `schedule` event with no target, and the tick delivers it as a new
task. Delivery already stops at `max_wakes_per_hour` and at two running tasks.
A spent budget leaves the event queued; it is not dropped and it is not
delivered early. These routines do not add a hop. If the woken task calls
`message_agent`, that call still uses `MAX_AGENT_HOPS`.

The same occurrence is stored in `schedule_event_keys`, so a merged PR or a
finished session does not queue twice. Changing the event type clears those
keys. Pausing does not.

| Event | Source | Not fired when |
|---|---|---|
| `session_finished` | `chat:done` | The session belongs to an agent (chat or task). Those already wake the owner through delegations, and a routine on them would loop. |
| `session_failed` | `chat:error` | Same agent-session exclusion. `chat:cancelled` is not a trigger. |
| `worktree_archived` | `worktree:archived` | The payload has no worktree id. |
| `pr_merged` | `pr:status-update` whose `state` is `merged` | The same worktree and PR number already woke this routine. Open and closed PRs do not match. |
| `approval_resolved` | `decide_approval`, after the result is queued back to the requesting session | The approval id already woke this routine. |

Not included, on purpose:

- **Usage-limit reset.** Codex stores `reset_at` on a usage snapshot, but Jean
  does not emit an event when a window resets. Watching that would be a new
  poller, not a hook on something that already happens.
- **A message from another agent.** `message_agent` already queues a `message`
  event for the target and records a hop. A second routine would wake that
  agent twice for one request.
- **An external webhook.** Jean has no inbound agent webhook. Adding one would
  be a new server and a new trust boundary, not a small hook.

## Memory

Three scopes. Do not treat `shared` as "facts about the user".

| Scope | Who sees it | What it is |
|---|---|---|
| `agent` | That agent only | Private rules, facts, and open work. `agent_id` is the owner. |
| `shared` | Every agent | Cross-agent working memory: rules, facts, and open work that are not about who the user is. `agent_id` is NULL. This is the old shared pool. Migration v5 sets `scope = 'shared'` on existing rows with `agent_id` NULL and `scope = 'agent'` on the rest. |
| `user` | Every agent | Facts about the user only (name, timezone, preferences). `kind` must be `fact`. `agent_id` is NULL. A separate section in the prompt and in the Memory view. |

`shared` stays a working-memory pool because it already mixes rules and open work. A preference is not the same thing as a shared operational rule, so user facts are a new scope rather than a reuse of `shared`.

Writes are direct, the same way other memory is written. The approval gate stays on destructive project tools (delete, push, merge, pull request). Every create, update, forget, and supersede appends a `memory_changes` row with the previous text, the new text, and who did it (`actor_agent_id` NULL means the user, from the Memory view). The Memory view lists that record. Superseding a fact inserts the new text and sets `superseded_by` on the old row, so the old text leaves search and prompts but the change remains. Only facts can be superseded; rules and open work are edited in place.

### Search and the prompt

`memory_search` (MCP) and `search_agent_memory` (command) use FTS5. Ranking is pinned first, then bm25 relevance, then `updated_at`. Filters: kind, scope, project, pinned, and an inclusive `from`/`to` range on `updated_at` (unix seconds). An agent never sees another agent's private rows. Expired rows are hidden from the tool and from prompts; the Memory view includes them until they are forgotten. Superseded rows are hidden from all of these.

Prompt assembly does not take the newest 40. `select_prompt_memories` fills an 8000-character budget:

1. User facts (pinned, then newest).
2. Then the agent's other visible memories: pinned, then FTS relevance to the current user message, then newest. The hint drops stopwords and words shorter than 3 characters, then ORs the rest, so a normal question can match. The search box still ANDs its terms.

Entries that do not fit are skipped. The prompt says to call `memory_search` for the rest. The chosen ids are logged as `[Agents] prompt memory for <id>: ...`.

### Journal

`journal` is per agent and separate from durable facts. `journal_add` / `save_agent_journal` record what happened, a decision, or an outcome (max 2000 characters). `journal_search` / `search_agent_journal` recall by FTS text and/or `occurred_at` range. Another agent's journal is not visible.

When a chat rotates (40 messages and 10 minutes idle), the end is still saved as `carry_over` for the new chat. The same text is also trimmed to 2000 characters, keeping the newest part, and stored as a journal entry with source `rotation`. That is a copy of the handoff, not a model summary. The log line is `[Agents] <id> continues in a new chat (... journal #<id> ...)`.

## MCP tools (`agents/mcp.rs`)

Agent-only tools: `schedule_create/update/list/cancel`, `memory_save/search/update/forget/supersede`, `journal_add/search`,
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
`delete_agent`, `decide_agent_approval`, `create_agent_schedule`,
`update_agent_schedule`, `cancel_agent_schedule`,
`save/search/update/delete/supersede/export_agent_memory`, `save/search_agent_journal`, `mark_agent_notifications_read`,
`get_agent_workdir`.
`create_agent_schedule` takes `kind` (`once`, `interval`, `cron`, `event`)
plus the fields for that kind (`delaySecs`, `everySecs`, `cron` + `timezone`,
or `event`). `update_agent_schedule` patches `name`, `prompt`, `paused`, and,
when `kind` is set, replaces the timing. Pause does not delete the routine.
Changes emit `cache:invalidate` with key `agents`.

## Stack size note

`dispatch_command` and the MCP `run_tool` are very large async functions. In
debug builds their poll frames are large enough to overflow tokio's default
2 MiB worker stack. Keep new arms out of them: put new command groups in a
separate function and call it through `Box::pin(...)`, as the agents commands
do. All entry points use `jean_core::build_tokio_runtime()` (8 MiB worker
stacks).
