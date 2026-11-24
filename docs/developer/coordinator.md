# Project coordinator

Every git project can have one coordinator. A coordinator is a persistent
agent chat that Jean creates for the project. The user chats with it. It does
not change code. It starts work in normal worktrees and sessions through the
Jean MCP tools (`create_worktree`, `create_session`, `send_chat_message`).
When one of those sessions ends, Jean wakes the coordinator, and the
coordinator posts a short status in its chat. Coordinators run on the backend,
so they keep working when no client is open.

Code: `jean-core/src/agents/` (backend), `src/components/agents/` and
`src/services/agents.ts` (UI). The Rust module and the commands keep the name
"agents". In the UI the feature is called **Project Coordinator**.

## Feature flag

The feature is experimental and off by default.

| Item         | Value                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| Setting      | **Settings → General → Experimental → Project Coordinator**                      |
| Preference   | `coordinator_enabled` (`AppPreferences`, `src/types/preferences.ts`)             |
| Old key      | `agents_enabled`. `#[serde(alias)]` loads it from a saved file.                  |
| Live check   | `agents::enabled(app)` reads the preference from disk on every call              |
| Search entry | `experimental-coordinator` in `src/components/preferences/preferences-search.ts` |

`patch_preferences` maps old keys to current keys before it merges a patch
(`RENAMED_PREFERENCE_KEYS` in `jean-core/src/lib.rs`). Without the mapping, a
patch with `agents_enabled` from an older client would put both keys in one
object, and serde would reject it as a duplicate field. The remote
`update_server_preferences` path uses `patch_preferences`, so it maps the
same keys.

The engine checks the flag on every tick and in every listener, so a change
applies without a restart. `save_preferences` calls `agents::nudge()`, so the
loop sees the change at once. While the flag is off, Jean creates no
coordinator, fires no schedule, and delivers nothing. When the flag turns on,
every project gets its coordinator, and Jean checks the active delegations
once.

The UI reads the flag per server. `useAgentsEnabledServers()`
(`src/components/agents/agents-feature.ts`) returns the local server and each
online remote server that has the flag on. A remote server that is still
loading its preferences counts as off.

## Data model

### Identity

| Item                        | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| Agent ID                    | `coord_<project_id>` (`db::coordinator_id`)              |
| Worktree ID of its sessions | `__coord_<project_id>__` (`db::coordinator_worktree_id`) |
| Working directory           | The project folder (`agents::agent_workdir`)             |
| Row                         | `agents.project_id` is set (migration v9, unique index)  |

Project IDs are UUIDs, so both IDs pass `sanitize_filename` unchanged.
`db::ensure_coordinator` refuses any other ID. In the frontend,
`coordinatorProjectId(agentId)` reverses the agent ID. Remote IDs carry the
`serverId:` prefix like every other server resource.

### Storage

The database is `{app_data}/agents.db` (SQLite through `rusqlite` with
`bundled`, so FTS5 is on and no system SQLite is used). Migrations are a list
in `agents/db.rs` (`MIGRATIONS`, tracked with `PRAGMA user_version`). Add a new
entry. Never edit an applied one.

| Table                       | Purpose                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                    | One row per coordinator (`project_id` set). Nothing is seeded.                                                                                                          |
| `delegations`               | "Session S works for coordinator A". `origin_session_id` is the coordinator session that sent the work.                                                                 |
| `events`                    | Queued updates for a coordinator (`delegation`, `schedule`, `approval`). All of them go to its chat. The `title` and `target_session_id` columns are no longer written. |
| `tasks`                     | Unused. Rows from the removed task sessions stay.                                                                                                                       |
| `notifications`             | `notify_user` messages. The `read_at` column is no longer written.                                                                                                      |
| `wakes`                     | One row per wake, for the hourly budget (`max_wakes_per_hour`).                                                                                                         |
| `schedules`                 | One-shot, interval, cron, and event routines.                                                                                                                           |
| `approvals`                 | Destructive MCP calls that wait for the user.                                                                                                                           |
| `memories` + `memories_fts` | Rules, facts, and open work. FTS5 is kept in sync by triggers.                                                                                                          |
| `memory_changes`            | Audit of create, update, forget, and supersede.                                                                                                                         |
| `journal` + `journal_fts`   | Dated history for one coordinator.                                                                                                                                      |

All functions in `db.rs` take a `&Connection`, so tests use an in-memory
database. Runtime code uses `agents::with_db(app, |conn| ...)`.

Rows with `project_id` NULL are the old built-in `jean` agent and the old
custom agents. They and their data stay in the database, and Jean does not
load them. `list_agents`, `get_agent`, `agent_by_worktree`, schedule firing,
pending events, and delegation checks all filter on `project_id IS NOT NULL`.
Orphan cleanup still skips their session index files (`__jean_agent__`,
`__agent_<id>__`) through `is_agent_worktree_id`.

## Lifecycle

- `agents::ensure_coordinator(app, project_id)` is idempotent. It runs for
  every project when the flag turns on (`ensure_all_coordinators`). It runs
  when a project is added (`on_project_added`, called from `add_project`,
  `init_project`, and `clone_project`). It also runs from
  `get_project_coordinator`.
- The coordinator name follows the project name.
- Folders and managed servers get no coordinator.
- `remove_project` calls `agents::remove_coordinator`. It stops and deletes
  the coordinator's chat sessions and their index, then deletes the row.
  Foreign keys delete its delegations, events, wakes, schedules, approvals,
  and notifications. `db::delete_coordinator` also deletes its private
  memories, their change records, and its journal, because those tables have
  no foreign key.
- Jean never deletes a coordinator at startup. A project list that failed to
  load must not delete memory.

## Chat session and wakes

Coordinator sessions are normal Jean sessions under the reserved worktree ID
`__coord_<project_id>__`. That ID has no worktree record. The sessions run in
the project folder. There is one continuous chat (the active session) plus the
closed chats from rotation. There are no task sessions. Schedule runs, event
routines, approval results, and delegation results all wake the same chat.

| Function                                                           | Job                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `agents::agent_for_worktree`                                       | Maps the worktree ID to the coordinator                    |
| `agents::workdir_for_worktree`, `resolve_worktree_path` (MCP core) | Map the worktree ID to the project folder                  |
| `agents::is_agent_worktree_id`                                     | Keeps the session index out of orphan cleanup              |
| `agents::system_prompt_for`                                        | Adds the coordinator prompt to every run, on every backend |

The coordinator prompt holds the role for the project (name and path), the
rule not to change code, and how to delegate (`create_worktree`,
`send_chat_message`, `read_session_messages`, one line per task sent). It also
lists the project's worktrees (at most 30) and the sessions the coordinator
waits for (at most 20). Then come the selected skills, memory within a size
budget, and the end of the previous chat (`carry_over`). A non-empty
`role_prompt` is added as "Instructions from the user".

Branch auto-naming is skipped for coordinator chats, because the branch in the
project folder belongs to the user.

### The engine loop

`agents/engine.rs` runs one loop per Jean process:

```
send_chat_message (MCP, caller = coordinator chat)
	└─ record_delegation ──► delegations(active)
chat:done / chat:error / chat:cancelled (in-process listener)
	└─ mark delegations of that session ──► check_after = now + 2s
tick (every 5s, or nudge(); skipped while coordinator_enabled is off)
	├─ delegation checks ──► event
	├─ due schedules (one-shot, interval, cron) ──► event
	│    event routines are queued by listeners, not by this tick
	├─ deliver: all queued events of a coordinator as one
	│    "[Jean agent update]" message into its chat
	└─ maintenance (every 60s):
	     └─ chat ≥ 40 messages and idle 10 min ──► new chat, old one closed,
	                                              end saved as carry_over, shorter
	                                              copy stored as a journal entry
```

`next_delivery` sends nothing while the chat runs or waits for input. It also
sends nothing when the hourly budget (`max_wakes_per_hour`) is spent. The
events stay queued, and the next tick tries again. The end of the chat's own
run nudges the loop, so updates that arrive during a turn go out right after
it. One delivery counts as one wake.

`next_delivery` marks the updates delivered, then `send_delivery` sends the
message and waits for the turn. Sometimes the chat does not record the message
(`UserTurnOutcome::NotAccepted`). The user sent a message first, or the
session cannot run. Then `db::requeue_events` puts the same updates back in
the queue, and a later tick sends them. The wake stays counted, so a send that
keeps failing stops at the hourly budget.

- Wakes never run in Plan mode (`wake_execution_mode`), because Plan mode
  blocks the Jean MCP tools. Cursor has no Build mode, so Cursor wakes use
  Yolo (`wake_execution_mode_for`).
- New chat sessions get an implement execution mode, saved once
  (`ensure_session_mode`). Old session JSON with no saved mode still loads as
  Plan, so those sessions are not escalated.
- At startup, Jean checks the active delegations once. Runs that ended while
  Jean was closed are still reported.

Test overrides (environment, for isolated test servers only):
`JEAN_AGENT_CHAT_ROTATE_MESSAGES` and `JEAN_AGENT_CHAT_ROTATE_IDLE_SECS`.
`JEAN_AGENT_CLOCK_FILE` points at a file that holds a positive Unix timestamp.
`db::now()` returns that value instead of the wall clock, so you can move a
cron routine onto its next slot during a local run. Leave it unset in normal
use.

## Delegations and status chips

A delegation means "this session works for this coordinator".
`send_chat_message` in `jean_mcp_core.rs` calls `agents::mcp::record_delegation`
when the caller is a coordinator session. The row stores the session, its
worktree, and the coordinator session that sent the work.

| Status      | Set when                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `active`    | The coordinator sent the message                                         |
| `waiting`   | The session waits for input: a plan approval, a question, or other input |
| `done`      | The run ended normally                                                   |
| `failed`    | The run errored or crashed, or the session or worktree is gone           |
| `cancelled` | The run was cancelled                                                    |

`engine::outcome_status` maps a finished session to a status.
`check_delegation` defers the check while the session still runs, including a
detached run that resumed after a restart. When the run ends, it queues an
event with the session name, the verb, the error (for `failed`), and the last
reply. The event wakes the coordinator chat.

The UI reads delegations from `get_agent_details`:

- `useCoordinatorDelegations(projectId, enabled)` (`src/components/agents/agents.ts`)
  returns the open delegations (`active` and `waiting`) of a project's
  coordinator.
- `spawnDelegationStatus(link, delegations)` (`agent-messages.ts`) returns the
  status of the newest delegation for one spawn card. A sent message matches
  by session. A created worktree matches by worktree.
- `STATUS_CHIPS` in `AgentMessageLink.tsx` shows the status as a chip:
  **running**, **waiting for input**, **done**, **failed**, or **cancelled**.

A chip shows the newest delegation for its session. A second message to the
same session moves every card for that session to the new status.

## Run configuration

Each coordinator can set `backend`, `model`, `effort`, `thinking_level`, and
`skills`. A field left unset (`NULL`, or `[]` for skills) uses the defaults
that a new chat session in the project would use.

| Field            | Stored as                                                                                            | Unset means                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `backend`        | `claude`, `codex`, `opencode`, `cursor`, `pi`, `commandcode`, `grok`, `kimi`, `antigravity`, or NULL | Session, project, and user default backend |
| `model`          | Model ID string, or NULL                                                                             | Preference model for the resolved backend  |
| `effort`         | `off`, `adaptive`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`, or NULL          | No effort override                         |
| `thinking_level` | `off`, `adaptive`, `think`, `megathink`, `ultrathink`, or NULL                                       | No thinking override                       |
| `skills`         | JSON array of `{name, path, backend?}`, default `[]`, at most 32                                     | No extra skills                            |

The `update_agent` patch uses a missing field for "leave it", JSON `null` for
"clear back to the default", and `skills: []` to clear skills.

The engine applies the fields in three places:

- Rotated chats are created with the coordinator's backend. An empty chat (no
  messages, no running turn) gets the same backend when the coordinator is
  created or its run configuration changes. A cleared backend resets that
  empty chat to the project's default backend, else the preference default.
  `list_agents` does not change the chat, so a toolbar choice made before the
  first message stays.
- Wakes pass `backend`, `model`, `effortLevel`, and `thinkingLevel` on
  `send_chat_message`. A set backend with an unset model also passes that
  backend's preference model, so a stale model from another backend is not
  sent. `send_chat_message` saves the backend on the session, so a chat with
  messages moves to a changed backend on the next wake, with the usual
  provider-switch handoff.
- Selected skills are added as the chat skill marker, both in the system
  prompt and in each wake message:

```
[Skill: /path/to/SKILL.md - Read and use this skill to guide your response]
```

OpenCode inlines the file from that marker. Other backends are told to read
it. Jean does not copy or rewrite skill files.

### Project settings

`ProjectsData::project_for_worktree` maps `__coord_<project_id>__` to its
project, and every chat lookup uses it. So the coordinator chat gets the
project's custom system prompt, linked projects, default provider, and
default backend, the same as a worktree of that project. The coordinator's own
run configuration wins over the project defaults. The chat window also
resolves the project from the `__coord_` ID.

A wake carries no `mcpConfig`. On backends with a per-session server list
(`connectors::session_support`), `apply_agent_mcp_allowlist` builds the list
from the servers the chat UI would enable. The order is the session's own
choice, then the project setting, then the global default. A saved
per-coordinator connector list wins over all of them. A wake does not turn on
new servers.

## The coordinator cannot edit code

`agents::code_is_read_only(worktree_id)` is true for coordinator worktree IDs.
Each backend that can block file writes checks it when it builds a run. So
the rule holds for user messages and wakes, in every execution mode.

| Backend                                                    | Enforced by                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Claude                                                     | `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` (`disallowed_tools_args`)                                              |
| Codex                                                      | Read-only sandbox on the thread and the turn, and an approval policy that cannot grant more access (`restrict_to_read_only`) |
| OpenCode 1.x and 2.x                                       | Last permission rule `edit` → `deny` (`permission_rules`)                                                                    |
| Pi                                                         | `--tools read,grep,find,ls,bash` (`pi_tools_for_mode`), except when the Pi agent owns its policy                             |
| Cursor, Command Code, Grok, Kimi, Devin, Antigravity, Muse | Not enforced. Only the prompt rule applies.                                                                                  |

Only Codex also blocks writes through the shell. On Claude, OpenCode, and Pi
the shell tool stays, because the coordinator reads the repository with it.
On those backends only the prompt stops a write through the shell. Plan mode
is not an option, because it blocks the Jean MCP tools.

## Schedules and routines

| Kind     | Stored as                                                  | Next run                                              |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| One-shot | `every_secs`, `cron`, and `event` NULL. `next_run_at` set. | Fires once, then `active=0`                           |
| Interval | `every_secs` ≥ 300                                         | `next_run_at = fired_at + every_secs`                 |
| Cron     | 5-field `cron` plus an IANA `timezone`                     | Next match strictly after the fire time, in that zone |
| Event    | `event` set. `next_run_at` is 0 and is not a clock time.   | When the event happens                                |

`paused=1` keeps the row, and the engine skips it. Cancel sets `active=0`.

### Cron

Cron takes five fields: `minute hour day-of-month month day-of-week`. It
accepts `*`, lists, ranges, steps, and English month and day names. It
rejects `?`. When both day-of-month and day-of-week are restricted, a date
matches if either field matches (standard cron). The timezone is stored on
the schedule. The UI defaults to the browser zone. An omitted MCP timezone
means UTC. Names that differ only by case still resolve.

The next run is calculated in local time in that zone:

- A match is strictly after the previous instant, so the slot that just fired
  is not chosen again.
- Spring-forward gaps are skipped. `30 2 * * *` on the US spring-forward day
  runs the next day at 02:30.
- Fall-back hours happen twice. All matches in the earlier offset come first,
  then all matches in the later offset.
- If Jean was closed, a due cron fires once and then moves to the next match
  after the actual fire time. Missed slots are not replayed.

Validation rejects an expression whose runs are closer than 300 seconds,
including a DST change that would push two matches together. The floor is the
same as for `every_secs`. `*/5 * * * *` is allowed. `*/4` and `* * * * *` are
not. Errors name the field or the gap.

### Event routines

`fire_event_schedules` inserts a `schedule` event, and the tick delivers it to
the chat. An event wakes only the coordinator of the project where it
happened: the project of the session's worktree, of the pull request's
worktree, or of the coordinator that asked for the approval. A spent budget
leaves the event queued. Jean does not drop it and does not deliver it early.

`schedule_event_keys` stores each occurrence, so a merged PR does not queue
twice. Session keys include the second of the event, so each run of a session
is a new occurrence. A change of the event type clears those keys. A pause
does not.

| Event               | Source                                                                       | Not fired when                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `session_finished`  | `chat:done`                                                                  | The session is a coordinator chat or an active delegation. Those already wake their coordinator, and a routine on them would loop. |
| `session_failed`    | `chat:error`                                                                 | Same exclusion. `chat:cancelled` is not a trigger.                                                                                 |
| `pr_merged`         | `pr:status-update` with `state` `merged`                                     | The same worktree and PR number already woke this routine                                                                          |
| `approval_resolved` | `decide_approval`, after the result is queued back to the requesting session | The approval ID already woke this routine                                                                                          |

Jean has no usage-limit-reset event and no inbound webhook.

## Memory and journal

| Scope    | Who sees it           | What it is                                                                                          |
| -------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `agent`  | That coordinator only | Private rules, facts, and open work. `agent_id` is the owner.                                       |
| `shared` | Every coordinator     | Rules, facts, and open work that hold in every project. `agent_id` is NULL.                         |
| `user`   | Every coordinator     | Facts about the user only (name, timezone, preferences). `kind` must be `fact`. `agent_id` is NULL. |

Writes are direct. Every create, update, forget, and supersede adds a
`memory_changes` row with the old text, the new text, and the actor.
`actor_agent_id` NULL means the user wrote it in the Memory tab. Supersede
inserts the new text and sets `superseded_by` on the old row. The old text
then leaves search and prompts, and the change record stays. Only facts can be
superseded. Rules and open work are edited in place.

`memory_search` (MCP) and `search_agent_memory` (command) use FTS5. Ranking is
pinned first, then bm25 relevance, then `updated_at`. Filters are kind, scope,
project, pinned, and an inclusive `from` to `to` range on `updated_at` (Unix
seconds). A coordinator never sees another coordinator's private rows. Expired
rows are hidden from the tool and from prompts. The Memory tab shows them
until they are forgotten. Superseded rows are hidden everywhere.

`select_prompt_memories` fills an 8000-character budget for the prompt:

1. User facts (pinned, then newest).
2. The coordinator's other visible memories: pinned, then FTS relevance to the
   current user message, then newest. The hint drops stopwords and words
   shorter than 3 characters and ORs the rest.

Entries that do not fit are skipped, and the prompt says to call
`memory_search` for the rest. The log line is
`[Agents] prompt memory for <id>: ...`.

The journal is per coordinator and separate from memory. `journal_add` and
`save_agent_journal` record an event, a decision, or an outcome (at most 2000
characters). `journal_search` and `search_agent_journal` search by FTS text,
by `occurred_at` range, or both. When a chat rotates, Jean saves the end of the
chat as `carry_over` for the new chat. It also stores the newest 2000
characters of that text as a journal entry with source `rotation`.

## Approvals and questions

Calls from a coordinator session to `delete_worktree`,
`permanently_delete_worktree`, `push_worktree`, `merge_pull_request`,
`create_pull_request`, `remove_project`, or `set_connector` do not run. Jean
stores them in `approvals`. When the user approves, `jean_mcp_core::run_approved_tool`
runs the same call, and the result goes to the coordinator as an event. The
gate is in `call_tool`, so it works on every backend and does not depend on
the prompt.

The chat shows each request at the tool call that made it (`agentApprovalId`
in `agent-messages.ts`, `AgentApprovalInline` in `AgentActivity.tsx`). The card
is an `AgentQuestionCard` with **Approve** and **Deny**. `describeApproval`
writes the text with worktree and coordinator names, not IDs or raw arguments.

`ask_user` takes `question`, 2 to 8 `options`, and `multiple`. The tool only
validates its input and returns `shown`. The chat renders the call as an
`AgentQuestionCard`. With one answer, a click sends it. With several answers, a
**Send** button sends one `- option` line each. The answer is a normal user
message, so it works on every backend. The card becomes read-only once the
user writes a message after it (`nextUserAnswers`). Automatic updates do not
count as user messages.

`notify_user` stores a notification and emits `agents:notification`.
`AgentNotificationsListener` shows it as a toast with an **Open** action that
opens the coordinator.

`set_status` returns only `shown`. The chat reads the latest call from the
streamed tool calls and shows its 2 to 5 word text in the status line
(`src/components/chat/agent-status.ts`).

## MCP tool gating

These tools are for coordinator sessions only: `schedule_create`,
`schedule_update`, `schedule_list`, `schedule_cancel`, `memory_save`,
`memory_search`, `memory_update`, `memory_forget`, `memory_supersede`,
`journal_add`, `journal_search`, `notify_user`, `set_status`, `ask_user`, and
`list_connectors` (`agents/mcp.rs`).

The Jean app answers `tools/list`, not the stdio proxy. The proxy sends
`{"method":"tools/list","source":<JEAN_MCP_SESSION>}` over the local socket,
and `jean_mcp_core::tools_list_for_source` returns the list for that session.
Every other session gets the project tools only (`set_connector` included).
A proxy that cannot reach the app also gets the project tools only. A call to a
coordinator tool from another session fails in `mcp::run`.

The caller is identified by `JEAN_MCP_SESSION`. Codex threads get it per
thread through a config override
(`jean_mcp_config::codex_session_config_override`), because the persistent
`~/.codex/config.toml` entry has only a fixed label.

When a coordinator session calls `send_chat_message`, the message starts with
`[Message from agent <name> (`<id>`)]` (`agents::agent_message_text`). The
receiving session shows one "Message from" line instead of the header. The tool
result also has `worktreeId`, `worktreePath`, `sessionName`, and
`worktreeName`, which the spawn card uses.

### Connector allowlists

A coordinator can save an allowlist of the user's MCP servers
(`agents.mcp_servers`) and, separately, of Jean MCP tools (`agents.jean_tools`).
Both are nullable JSON.

| Stored value | Meaning                           |
| ------------ | --------------------------------- |
| `NULL`       | No limit                          |
| `[]`         | A saved limit that allows nothing |
| A JSON array | Only those entries                |

`send_chat_message` calls `apply_agent_mcp_allowlist` before it merges the
Jean MCP entry, for every send, wakes included:

- `mcp_servers` is `NULL`: the caller's `mcpConfig` stays.
- The session backend is Claude or Grok and a list is saved: `mcpConfig` gets
  only the discovered servers on that backend whose names are in the list. If
  discovery fails, the config becomes `{"mcpServers":{}}`. Jean MCP is merged
  afterwards, so the list does not remove it.
- Any other backend: `mcpConfig` stays, and Jean logs that the limit was not
  applied. The UI shows **Unsupported on this backend** and disables the
  switches.

`call_tool` enforces the Jean tool list before the approval gate. `NULL`
allows every tool. `claude_permission_prompt` stays callable so Claude's
permission hook still works. The list applies only to the coordinator's own
session. A session that the coordinator starts is a normal session with no
limit.

`list_connectors` reports the saved limit, the discovered servers, and whether
this backend applied the limit. It returns no server config, because config
can hold tokens. `set_connector` (needs approval) turns one discovered server
on or off in the `global`, `project`, or `agent` list. It saves through
`patch_preferences`, `update_project_settings`, or `update_agent`.
`get_agent_connector_catalog` returns which backends can apply a limit, the
reason for each backend, and the Jean tool names. Resolution is in
`agents/connectors.rs`. For how each backend discovers and receives MCP
servers, see `chat/mcp_external.rs` and `resolveEnabledMcpServers`.

## Commands

All agent commands are served by `dispatch_agents_command` in
`jean-core/src/http_server/dispatch.rs` (`AGENT_COMMANDS`). Native IPC calls
the same function through `dispatch_core_command`, so there is no separate
`generate_handler!` entry. Changes emit `cache:invalidate` with key `agents`.

| Command                                                                                                                                   | Returns or does                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_coordinator`                                                                                                                 | `{ agentId, worktreeId, worktreePath, chatSessionId, backend, model, effort, thinkingLevel }`. Creates the coordinator and its chat when they do not exist, and a new chat when the user closed the last one. |
| `list_agents`                                                                                                                             | One summary per coordinator. Reads `agents.db`, the process registry, and an existing session index. Loads no chat.                                                                                           |
| `get_agent_details`                                                                                                                       | Delegations, schedules, approvals, memories, journal, memory changes, and notifications                                                                                                                       |
| `update_agent`                                                                                                                            | Patches the run configuration and the connector lists                                                                                                                                                         |
| `decide_agent_approval`                                                                                                                   | Approves or denies a stored call                                                                                                                                                                              |
| `create_agent_schedule`, `update_agent_schedule`, `cancel_agent_schedule`                                                                 | Schedule CRUD. `kind` is `once`, `interval`, `cron`, or `event`.                                                                                                                                              |
| `save_agent_memory`, `search_agent_memory`, `update_agent_memory`, `delete_agent_memory`, `supersede_agent_memory`, `export_agent_memory` | Memory                                                                                                                                                                                                        |
| `save_agent_journal`, `search_agent_journal`                                                                                              | Journal                                                                                                                                                                                                       |
| `get_agent_connector_catalog`                                                                                                             | Connector capabilities                                                                                                                                                                                        |
| `get_agent_workdir`                                                                                                                       | The project folder                                                                                                                                                                                            |

In `list_agents`, `homeSessionId` is `null` until the chat was opened once.
`activity` is the latest notification. `status` is `working` (a turn runs),
`waiting` (an approval is pending), or `idle`.

`dispatch_command` and the MCP `run_tool` are very large async functions. In
debug builds their poll frames can overflow tokio's default 2 MiB worker
stack. Put new command groups in a separate function and call it through
`Box::pin(...)`, as the agent commands do. All entry points use
`jean_core::build_tokio_runtime()` (8 MiB worker stacks).

## UI

### Project view switch

`ProjectView` (`src/components/dashboard/ProjectView.tsx`) shows a
**Coordinator | Sessions** switch in the project header when the flag is on for
the project's server. Folders and server projects never get the switch.
**Coordinator** renders `CoordinatorView`. **Sessions** is the classic
`ProjectCanvasView` (all worktrees and sessions, search, New worktree, filters
and Base Session), with the switch in its header (`headerAccessory`). The last
choice per project
is stored in `projectViewModes` (UI store, client view state). The default is
**Coordinator**. `openProjectCoordinator(projectId)` opens a project in
coordinator mode. The command palette uses it in its **Coordinators** group,
and the notification toast uses it for **Open**.

### Coordinator view

`CoordinatorView` (`src/components/agents/CoordinatorView.tsx`) shows the
coordinator chat as the main panel. The chat is a `ChatWindow` with
`agentChat` (no Plan mode), bound to the coordinator's current chat session.
With **Show tool calls in the chat** (`agentsAdvanced`) off, the chat hides
tool calls and shows "Coordinator is working" while a turn runs.

A hidden, embedded `ProjectCanvasView` stays mounted, because its
`SessionChatModal` opens the sessions that the spawn cards and the
Sessions tab link to (`open-session-modal` event).

If `get_project_coordinator` fails with "Unknown command", the view says that
the server needs an update.

### Details sidebar

The right sidebar has four tabs. It is closed by default. On mobile it opens
as a full-screen sheet.

| Tab       | Component                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sessions  | `CoordinatorWorktrees`                                                                                                    |
| Memory    | `AgentMemoryView`                                                                                                         |
| Schedules | `AgentSchedules`                                                                                                          |
| Settings  | `AgentSettings`: run configuration (`AgentRunFields`), connectors (`AgentConnectors`) and **Show tool calls in the chat** |

| Item      | Value                                                                                 |
| --------- | ------------------------------------------------------------------------------------- |
| Toggle    | Header button, or the `toggle_coordinator_sidebar` keybinding (default `mod+shift+w`) |
| Width     | 280 to 640 px, drag the left edge                                                     |
| Persisted | `coordinatorSidebarOpen` and `coordinatorSidebarWidth` in client view state           |

### Coordinator sessions list

`CoordinatorWorktrees` is a plain list of the sessions the coordinator
started: the `delegations` from `get_agent_details` (newest 30, every
status), resolved to worktree and session through `get_recent_worktrees` with
`includeSessionIds`. Base sessions are left out. Each row has a status dot
(running, waiting, failed or done), the worktree name, the session name and
the relative time. Running rows go first, then waiting. A click opens the
session. Only the Sessions tab of the details sidebar shows this list.

### Spawn cards and badge

`AgentMessageLink.tsx` renders the coordinator's `create_worktree` call as
"→ Created worktree" and its `send_chat_message` call as "→ Sent to". Each card
has a short quote of the message (`messageSnippet`) and a status chip (see
[Delegations and status chips](#delegations-and-status-chips)). A click opens
the session. In the receiving session, the message shows as one
"Message from" line.

`CoordinatorBadge` ("Coord.") marks session tabs in `SessionChatModal` that
have an open delegation (`useCoordinatorDelegations`).

### Mobile and web access

Web access uses the same components. All commands go through
`dispatch_agents_command`, so they work over WebSocket.

On mobile, `ProjectView` shows the same switch, the same `CoordinatorView` and
the same `ProjectCanvasView` (with its mobile layout).
The details sidebar opens as a full-screen sheet, and opening a session from
its Sessions tab closes the sheet.
