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
  An empty home chat (no messages, no running turn) is stamped the same way
  when the agent is created or its run configuration changes, so the chat
  toolbar shows the choice. A cleared backend or model resets that empty chat
  to the preference default. Listing agents does not stamp, so a toolbar
  choice made before the first message is kept.
- Wake-ups pass `backend`, `model`, `effortLevel`, and `thinkingLevel` on
  `send_chat_message`. A set backend with an unset model also passes that
  backend's preference model, so a stale model from another backend is not
  sent. `send_chat_message` saves the wake's backend on the session, so a home
  chat that already has messages moves to a changed backend on the next wake,
  with the usual provider-switch handoff. An unset backend keeps the session's
  backend.
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
       │                                        end saved as carry_over
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
- Fall-back overlap hours are real twice. All matches in the earlier offset
  come first, then all matches in the later offset. `*/5` runs every 5 minutes
  through both passes.
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

The same occurrence is stored in `schedule_event_keys`, so a merged PR does
not queue twice. Session and archive keys include the second they happened,
so each run of a session is a new occurrence. Changing the event type clears those
keys. Pausing does not.

| Event | Source | Not fired when |
|---|---|---|
| `session_finished` | `chat:done` | The session belongs to an agent (chat or task) or is an active delegation. Those already wake their agent, and a routine on them would loop. |
| `session_failed` | `chat:error` | Same exclusion. `chat:cancelled` is not a trigger. |
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

## MCP tools (`agents/mcp.rs`)

Agent-only tools: `schedule_create/update/list/cancel`, `memory_save/search/update/forget`,
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
`save/update/delete/export_agent_memory`, `mark_agent_notifications_read`,
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

## Self-management

An agent can change itself, and Jean can change any agent, through MCP.
Migration v5 (`migration_v5_agent_self_management` in `agents/db.rs`) adds
`agent_changes`. Do not edit v1–v4. A later stack may renumber this step.

| Tool | Who can run it immediately | Otherwise |
|---|---|---|
| `agent_list` | Any agent. Other agents' instructions and skills are omitted. | |
| `agent_update` | The agent itself, or Jean (any agent). Fields: name, description, instructions, color, backend, model, effort, thinking level, skills, paused. | Updating a different agent stores an approval. The Activity tab shows it. Nothing is written until the user approves. |
| `agent_create` | Any agent, within the caps below. Optional `schedules` use the same timing fields as `schedule_create`. | |
| `agent_delete` | Jean, for any agent except itself. | Every other delete, including deleting yourself, waits for approval. Built-in agents are refused, not queued. |
| `agent_revert` | Jean, for anyone. Another agent, for its own latest change, except undoing its own creation (that deletes it). | Those deletes wait for approval. |
| `schedule_*` | The calling agent's own schedules, as before. Each change is audited. | Schedules of another agent stay on that agent's tools. |

Jean is the built-in coordinator (`builtin`, id `jean`). The user, through the
Agents UI, follows Jean's rule: create, update, and delete apply immediately
and are audited with actor `user`.

### No privilege escalation

A created agent, and an update of a different agent, cannot be given more than
the actor has right now:

- Backend and model must match the actor, or stay unset. Keeping the target's
  current value is allowed.
- Effort and thinking cannot rank above the actor's. Unset means no grant.
  Ranks: effort `off < adaptive < minimal < low < medium < high < xhigh < max < ultracode`;
  thinking `off < adaptive < think < megathink < ultrathink`.
- A skill can be added only when the actor already has that path. Skills the
  target already has can stay.
- The new agent's `max_wakes_per_hour` is clamped to the actor's. Jean is not
  clamped and can set any valid config.

An agent may raise its own effort, model, backend, or skills. Children created
after that are capped at the new values. `max_wakes_per_hour` is not an MCP
field, so an agent cannot raise its own wake budget.

### Caps

20 user-created agents (Jean is not counted). 5 creates per rolling hour.
The hourly count is `agent_changes` rows with `action = 'create'`, so deleting
an agent does not free the hour. Reverting a delete also checks both caps.
UI creates share the same counters.

### Audit and revert

Every create, update, delete, and schedule change stores `before` and `after`
JSON and a one-line summary. The Activity tab lists them (newest first) for
the agent and for changes it made. Revert applies the `before` snapshot of the
latest change for that agent:

- update → previous fields
- create → delete (schedules go with the agent)
- delete → insert the snapshot again
- schedule create → cancel; cancel → reactivate; update → previous schedule

Only that latest change can be reverted. Revert writes its own audit row, so
reverting again undoes the revert. The Agents list, header, and settings form
refresh from `cache:invalidate` key `agents`. Settings keep a draft the user
is editing; an untouched form takes the server values.
