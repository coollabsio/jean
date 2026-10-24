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

In the UI, `AgentRunFields` edits these fields for the New agent dialog, the
Settings tab, and subagent types. It reuses the chat toolbar's
`DesktopBackendModelPicker` and `ReasoningLevelDropdown`, so agents and chats
pick backends, models, effort, and thinking the same way. Each picker has a
**Default** entry (`AGENT_DEFAULT_OPTION`); the draft stores it as an empty
string and `agentRunPatch` sends `null`. "Use default" clears the backend and
every override. Agent tabs share layout pieces from
`src/components/agents/agent-ui.tsx` (section headers, bordered lists, empty
states, badges, save footers).

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

## Memory

Three scopes. Do not treat `shared` as "facts about the user".

| Scope | Who sees it | What it is |
|---|---|---|
| `agent` | That agent only | Private rules, facts, and open work. `agent_id` is the owner. |
| `shared` | Every agent | Cross-agent working memory: rules, facts, and open work that are not about who the user is. `agent_id` is NULL. This is the old shared pool. Migration v6 sets `scope = 'shared'` on existing rows with `agent_id` NULL and `scope = 'agent'` on the rest. |
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

**Agent messages in the chat:** an agent chat shows each `message_agent` and
`send_chat_message` call as one "Messaged <target>" line, not as the full
text. When an agent session calls `send_chat_message`, the message starts with
`[Message from agent <name> (`<id>`)]` (`agents::agent_message_text`), so the
receiving session shows one "Message from <agent>" line. The tool result also
has `worktreeId`, `worktreePath`, `sessionName` and `worktreeName`. A click on
a line opens the conversation dialog (`AgentMessageLink.tsx`). For
`message_agent`, the dialog finds the target's first `Request from <sender>`
task created after the send (`findRequestTask` in `agent-messages.ts`).

**Approval gate:** `delete_worktree`, `permanently_delete_worktree`,
`push_worktree`, `merge_pull_request`, `create_pull_request` and
`remove_project` called from an
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

## Subagent types

An agent can define named workers and spawn one to do a single task. The
spawned session is a normal task under `__agent_tasks_<id>__`. Its result
returns through the existing delegation path: when the session finishes, the
origin session receives a `[Jean agent update]`. Claude Task and Codex
multi-agent runs stay in the chat `AgentWidget`; these subagents show on the
agent's Tasks tab with their type name.

Migration `subagent_types_migration_sql()` in `agents/db.rs` is its own step
in `MIGRATIONS` (currently the last one; a later rebase may renumber it). Do
not fold it into an older step. It creates `subagent_types` and adds nullable
snapshot columns on `tasks`. Existing task rows keep `spawn_depth` 0 and a
null type, so schedules and agent messages behave as before.

| Field | Stored as | Unset means |
|---|---|---|
| `agent_id` | agent id, or NULL | NULL is shared with every agent |
| `name` | text, unique per scope, case-insensitive | required |
| `description` | text | empty |
| `instructions` | role prompt, max 8000 characters | the parent agent's role prompt |
| `backend`, `model`, `effort`, `thinking_level`, `skills` | same values as the agent | inherit the parent agent |
| `permission_mode` | `plan`, `build`, or `yolo` | the normal agent wake mode (not Plan, Yolo for Cursor) |
| `tool_mode` | `read_only`, or NULL | the agent's tools. Delete, push, merge, and pull request creation still wait for approval |

Resolution prefers the agent's own type over a shared type with the same name.
The resolved backend, model, effort, thinking level, skills, instructions, and
modes are copied onto the task row at spawn. Later edits to the type do not
change a task that is already running. The session is created with that
backend and model. The instructions are written into the task message and
appended to the system prompt for that session.

`spawn_subagent` (MCP) and `spawn_agent_subagent` (UI) both refuse the spawn
when any of these is already spent:

- `MAX_RUNNING_TASKS` (2) running tasks for that agent
- the agent's hourly wake budget (`max_wakes_per_hour`)
- `MAX_AGENT_HOPS` (the caller's hop plus one)
- `MAX_SUBAGENT_SPAWN_DEPTH` (1). A spawned subagent is depth 1 and cannot
  spawn, and it cannot call `subagent_type_save` or `subagent_type_delete`

A `read_only` subagent can list and search. It cannot spawn, message agents,
change memory or schedules, or call mutating project tools. `read_only` limits
the Jean MCP tools only. The backend's own file and shell tools follow
`permission_mode`, so use `plan` to stop edits too. The approval gate still
applies when `tool_mode` is unset.

Only the user can make a type run as Yolo: `permission_mode` `yolo`, or a
Cursor backend without `plan`. `subagent_type_save` refuses that unless the
agent already wakes as Yolo or the user set it on that type before.

MCP tools, in their own block in `agents/mcp.rs`: `subagent_type_list`,
`subagent_type_save`, `subagent_type_delete`, `spawn_subagent`. Commands, in
their own block in `dispatch_agents_command`: `list_agent_subagent_types`,
`save_agent_subagent_type`, `delete_agent_subagent_type`,
`spawn_agent_subagent`. The agent page Subagents tab creates, edits, and
deletes types and can spawn one. `get_agent_details` includes `subagentTypes`.

## Stack size note

`dispatch_command` and the MCP `run_tool` are very large async functions. In
debug builds their poll frames are large enough to overflow tokio's default
2 MiB worker stack. Keep new arms out of them: put new command groups in a
separate function and call it through `Box::pin(...)`, as the agents commands
do. All entry points use `jean_core::build_tokio_runtime()` (8 MiB worker
stacks).

## Per-agent connectors

An agent can save an allowlist of the user's MCP servers and, separately, of
Jean MCP tools. The columns are `agents.mcp_servers` and `agents.jean_tools`
(JSON, nullable). Migration v5 in `agents/db.rs` adds them. Do not edit
v1–v4. Existing rows stay `NULL`.

| Stored value | Meaning |
|---|---|
| `NULL` | No limit. Today's behavior. |
| `[]` | A saved limit that allows nothing (no user MCP servers, or no Jean tools). |
| a JSON array | Only those entries. |

`update_agent`'s patch uses a missing field for "leave it" and JSON `null` for
"clear back to no limit". `get_agent_connector_catalog` returns which backends
can apply a limit, the reason for each backend, and the Jean tool names.
Resolution lives in `agents/connectors.rs`.

### How MCP servers are discovered

Discovery is per backend CLI, not per agent. `get_mcp_servers` reads that
CLI's config files and then appends servers the CLI reported itself
(`chat/mcp_external.rs`: claude.ai connectors, plugins, ChatGPT apps, remote
config). The file readers are:

| Backend | Config files | CLI list |
|---|---|---|
| Claude | `~/.claude.json` (`mcpServers` and `projects[path].mcpServers`), `<worktree>/.mcp.json` | `claude mcp list` for `claude.ai` and `plugin:` names |
| Codex | `~/.codex/config.toml` and `<worktree>/.codex/config.toml` `[mcp_servers.*]` | app-server `mcpServerStatus/list` |
| OpenCode | project, home, and `~/.config/opencode` `opencode.json` / `.jsonc` `mcp` object | `opencode mcp list` |
| Cursor | `~/.cursor/mcp.json` and `<worktree>/.cursor/mcp.json` | `cursor-agent mcp list` |
| Grok | `~/.grok/config.toml` and project `.grok/config.toml`, plus Claude, Cursor, and `.mcp.json` compat files | `grok mcp doctor --json` |
| Kimi | `~/.kimi-code/mcp.json` and project `.kimi-code/mcp.json` | none |
| Antigravity | `~/.gemini/config/mcp_config.json` and `<worktree>/.agents/mcp_config.json` | none |

`get_mcp_servers` with an unknown backend, including Pi and Command Code,
falls through to Claude's files. Agent settings only ask for a backend that
has its own reader. An unknown backend name is not treated as that CLI's
server list.

External servers are cached per backend and worktree. Their `config` is only
`{ jeanExternal: true, target }`. Jean must not pass that object as a server
definition the CLI should spawn. Claude's `--mcp-config` path already strips
those names and, when one is enabled, skips `--strict-mcp-config` and denies
the other known servers instead.

### How a session receives them

The chat UI builds `mcpConfig` (`{"mcpServers":{name: config}}`) from the
enabled names and sends it on `send_chat_message`. The cascade is session
override, then project, then global defaults, then auto-enable of newly
discovered servers (`resolveEnabledMcpServers`). Antigravity is forced on for
every non-disabled server because the CLI has no per-run switch.

| Backend | Per session? | What Jean actually does |
|---|---|---|
| Claude | Yes | `--mcp-config` and, when no external server is enabled, `--strict-mcp-config`. The flag drops every server that is not in the JSON, including the user's global config. |
| Grok | Yes | ACP `mcpServers` on `session/new` and `session/load`. Jean also rewrites `disabled_mcp_servers` in `~/.grok/config.toml` for the turn and restores it after. Two Grok turns at once can race on that file. |
| Cursor | No | `cursor mcp enable` / `disable` before launch. That changes shared workspace approval and is not restored. It is not a process-local config. |
| Codex | No | `~/.codex/config.toml`. Thread start can override `mcp_servers.<jean>.env.JEAN_MCP_SESSION` so the Jean server sees the session id. It cannot replace the server list. `config/mcpServer/reload` reloads the shared config. |
| OpenCode | No | The HTTP session has no MCP config argument. OpenCode reads `opencode.json`. |
| Pi | No | No MCP argument on the session. |
| Command Code | No | No MCP argument on the session. |
| Kimi | No | ACP `session/new` and `session/resume` always send `mcpServers: []`. The CLI then uses its own config. Jean does not put servers into that list, and does not treat the empty array as a restriction it can edit. |
| Antigravity | No | The CLI loads every enabled server from its persistent config. |

For Claude, Grok, and Cursor, `send_chat_message` merges the Jean MCP entry
into `mcpConfig` when Jean MCP is on. A wake that omits `mcpConfig` therefore
starts those three with Jean MCP only. Codex, OpenCode, Pi, Command Code,
Kimi, and Antigravity ignore that JSON and load whatever is installed
globally, including Jean MCP when it was installed into that CLI's config.

### In-app sign-in

`prepare_mcp_login` (`chat/mcp_auth.rs`) works for Claude and Codex only. It
checks the server is in `get_mcp_servers` for the worktree, then returns
`mcp login --no-browser <name>` for the embedded login terminal. Other
backends return an error. The button is `McpSignInButton` / `openMcpLogin`.
OAuth itself stays inside the CLI. Agent settings reuse that button and pass
the agent scratch folder as the worktree, which is where the agent session
runs.

### What the agent limit does

`send_chat_message` calls `apply_agent_mcp_allowlist` before the Jean MCP
merge, for every send, including engine wakes.

- `mcp_servers` is `NULL`: the caller's `mcpConfig` is unchanged.
- The session backend is Claude or Grok and a list is saved: replace
  `mcpConfig` with only the discovered servers on that backend whose names are
  in the list. A server saved for another backend is ignored for this turn.
  Discovery failure replaces the config with `{"mcpServers":{}}` so a broader
  caller config is not kept. Jean MCP is merged afterwards and is not removed
  by this list.
- Any other backend: leave `mcpConfig` unchanged and log that the limit was
  not applied, with the reason above. The UI shows **Unsupported on this
  backend** and disables the switches. There is no silent success.

An empty saved list on Claude or Grok passes no user servers. That is
different from `NULL`, where a chat can still send the session's own
`mcpConfig`, and a wake still sends none.

Jean tool names are a second allowlist, enforced in `call_tool` before the
approval gate. `NULL` allows every tool. A list allows only those names.
`claude_permission_prompt` stays callable so Claude's permission hook still
works. Destructive tools that are allowed still wait for approval. The list
applies only to the agent's own session. A session the agent starts with
`create_session` or `send_chat_message` is a normal session with no limit, so
leave those tools off when the limit must hold. The
read-only agent tool `list_connectors` reports the saved limit, the discovered
servers, and whether this backend applied the limit. It does not change
anything and does not return server config (that can hold tokens).

The settings section is **Connectors and tools** on the agent page. With no
saved MCP limit the switches are off (nothing is selected). Turning one on
starts the allowlist. Jean tool switches start on, because no limit means
every tool. Status badges are **Enabled**, **Off**, **Default**, **Needs
sign-in** (from `check_mcp_health`), and **Unsupported on this backend**.
Needs sign-in wins over Enabled so the sign-in button stays visible. Sign-in
is shown for Claude and Codex, which are the backends `prepare_mcp_login`
supports. Codex can sign in and still cannot apply the allowlist; the badge
says unsupported.

## Self-management

An agent can change itself, and Jean can change any agent, through MCP.
Migration v7 (`migration_v7_agent_self_management` in `agents/db.rs`) adds
`agent_changes`. Do not edit v1–v6. A later stack may renumber this step.

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
  Ranks: effort `off < none < adaptive < minimal < low < medium < high < xhigh < max < ultracode`;
  thinking `off < adaptive < think < megathink < ultrathink`.
- A skill can be added only when the actor already has that path. Skills the
  target already has can stay.
- The new agent's `max_wakes_per_hour` is clamped to the actor's, and it
  copies the actor's `mcp_servers` and `jean_tools` limits. Jean is not
  clamped and can set any valid config.

An agent may raise its own effort, model, backend, or skills. Children created
after that are capped at the new values. `max_wakes_per_hour` is not an MCP
field, so an agent cannot raise its own wake budget. `mcp_servers` and
`jean_tools` are not MCP fields either; only the Agents UI changes them.

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

Only that latest change can be reverted. A revert that waits for approval
stores the change ID; if a newer change lands first, the approved revert fails
and changes nothing. Revert writes its own audit row, so
reverting again undoes the revert. The Agents list, header, and settings form
refresh from `cache:invalidate` key `agents`. Settings keep a draft the user
is editing; an untouched form takes the server values.
