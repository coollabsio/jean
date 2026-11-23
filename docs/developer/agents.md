# Agents (project coordinators)

Every git project has one coordinator: a persistent agent that Jean creates
automatically. The user chats with it. It does not change code itself. It
starts work in normal worktrees and sessions through the Jean MCP tools
(`create_worktree`, `create_session`, `send_chat_message`), and when one of
those sessions ends, Jean wakes the coordinator and it posts a short status in
its chat. Coordinators run on the backend, so they keep working with no client
open.

The feature is experimental: **Settings → General → Experimental → Agents**
(`agents_enabled`, default off). The engine reads the preference on every tick
and in every listener, so turning it on or off applies without a restart.
While it is off, no coordinator is created, no schedule fires, and nothing is
delivered. When it is turned on, every project gets its coordinator and the
delegations that were active are checked once.

Code: `jean-core/src/agents/` (backend), `src/components/agents/` and
`src/services/agents.ts` (UI). The UI still shows the old agents page; the
project coordinator view replaces it.

## Coordinator identity and lifecycle

| Thing | Value |
|---|---|
| Agent ID | `coord_<project_id>` (`db::coordinator_id`) |
| Worktree ID of its sessions | `__coord_<project_id>__` (`db::coordinator_worktree_id`) |
| Working directory | The project folder (`agents::agent_workdir`) |
| Row | `agents.project_id` is set (migration v9, unique index) |

Project IDs are UUIDs, so both IDs pass `sanitize_filename` unchanged.
`db::ensure_coordinator` refuses any other ID.

- `agents::ensure_coordinator(app, project_id)` is idempotent. It runs for
  every project when the feature turns on (`ensure_all_coordinators`), when a
  project is added (`on_project_added`, called from `add_project`,
  `init_project` and `clone_project`), and from `get_project_coordinator`.
  The coordinator name follows the project name. Folders and managed servers
  get no coordinator.
- `remove_project` calls `agents::remove_coordinator`: it stops and deletes
  the coordinator's chat sessions and their index, then deletes the row.
  Foreign keys delete its delegations, events, wakes, schedules, approvals
  and notifications. `db::delete_coordinator` also deletes its private
  memories, their change records, and its journal, which have no foreign key.
- Coordinators are never deleted at startup. A project list that failed to
  load must not delete memory.
- Rows with `project_id` NULL are the old built-in `jean` agent and old custom
  agents. They and their data stay in the database and are not loaded:
  `list_agents`, `get_agent`, `agent_by_worktree`, schedule firing, pending
  events and delegation checks all filter `project_id IS NOT NULL`. Their
  session index files (`__jean_agent__`, `__agent_<id>__`) are still skipped
  by orphan cleanup (`is_agent_worktree_id`).

## Storage

`{app_data}/agents.db` (SQLite, `rusqlite` with `bundled`: FTS5 on, no system
SQLite). Migrations are a list in `agents/db.rs` (`MIGRATIONS`, tracked with
`PRAGMA user_version`). Add a new entry; never edit an applied one.

| Table | Purpose |
|---|---|
| `agents` | One row per coordinator (`project_id` set). Nothing is seeded. |
| `delegations` | "Session S works for agent A". `origin_session_id` = the agent session that sent the work. Status: `active`, `waiting`, `done`, `failed`, `cancelled`. |
| `events` | Queued updates for a coordinator (`delegation`, `schedule`, `approval`). All of them go to its chat. The `title` and `target_session_id` columns are no longer written. |
| `tasks` | Unused. Rows of the removed task sessions are kept. |
| `notifications` | `notify_user` messages (inbox, toast). |
| `wakes` | One row per wake-up, for the hourly budget (`max_wakes_per_hour`). |
| `schedules` | One-shot, interval (`every_secs`), cron, and event routines. |
| `approvals` | Destructive MCP calls that wait for the user. |
| `memories` + `memories_fts` | Rules, facts, open work. `scope` is `agent` (this project's coordinator), `shared` (all coordinators: facts that hold in every project), or `user` (facts about the user). `agent_id` NULL for shared and user. Superseded rows stay but drop out of search and prompts. FTS5 kept in sync by triggers. |
| `memory_changes` | Audit of create, update, forget, and supersede (before and after text, who did it). |
| `journal` + `journal_fts` | Dated history for one agent, including a short copy of a chat when it rotates. |

All functions in `db.rs` take a `&Connection`, so tests use an in-memory
database. Runtime code uses `agents::with_db(app, |conn| ...)`.

## Coordinator sessions

Coordinator sessions are normal Jean sessions under the reserved worktree ID
`__coord_<project_id>__`, which has no worktree record. They run in the
project folder. There is one continuous chat (the active session) plus the
closed old chats from rotation. There are no task sessions: schedule runs,
event routines, approval results and delegation results all wake the chat.

`agents::agent_for_worktree` maps the worktree ID to the coordinator,
`agents::workdir_for_worktree` and `resolve_worktree_path` (MCP core) map it
to the project folder, and `agents::is_agent_worktree_id()` keeps its session
index out of orphan cleanup.

`agents::system_prompt_for()` adds the coordinator prompt to every run in a
coordinator worktree, for every backend: the role for project <name> at
<path>, the rule not to change code, how to delegate (`create_worktree`,
`send_chat_message`, `read_session_messages`, one line per task sent), the
project's worktrees (at most 30), the sessions it waits for (at most 20),
selected skills, memory within a size budget, and the end of the previous chat
(`carry_over`). A non-empty `role_prompt` is added as "Instructions from the
user".

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

`update_agent`'s patch uses a
missing field for "leave it", JSON `null` for "clear back to the default", and
`skills: []` to clear skills. It goes through
`dispatch_agents_command` in `jean-core/src/http_server/dispatch.rs`. Native
IPC calls that same function via `dispatch_core_command`; there is no separate
`generate_handler!` entry for agent commands.

In the UI, `AgentRunFields` edits these fields for the
Settings tab. It reuses the chat toolbar's
`DesktopBackendModelPicker` and `ReasoningLevelDropdown`, so agents and chats
pick backends, models, effort, and thinking the same way. Each picker has a
**Default** entry (`AGENT_DEFAULT_OPTION`); the draft stores it as an empty
string and `agentRunPatch` sends `null`. "Use default" clears the backend and
every override. Agent tabs share layout pieces from
`src/components/agents/agent-ui.tsx` (section headers, bordered lists, empty
states, badges, save footers).

The engine applies the fields in three places:

- Rotated chats are created with the agent's backend.
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
send_chat_message (MCP, caller = coordinator chat)
  └─ record_delegation ──► delegations(active)
chat:done / chat:error / chat:cancelled (in-process listener)
  └─ mark delegations of that session ──► check_after = now + 2s
tick (every 5s, or nudge(); skipped while agents_enabled is off)
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

Delivery (`next_delivery`) sends nothing while the chat runs or waits for
input, or when the hourly budget (`max_wakes_per_hour`) is spent. The events
stay queued and the next tick tries again. The end of the chat's own run
nudges the loop, so updates that arrived during a turn are delivered right
after it. One delivery counts as one wake.

Saving preferences nudges the loop, so a change of `agents_enabled` is seen at
once.

Test overrides (environment, for isolated test servers only):
`JEAN_AGENT_CHAT_ROTATE_MESSAGES`, `JEAN_AGENT_CHAT_ROTATE_IDLE_SECS`.
`JEAN_AGENT_CLOCK_FILE` points at a file whose
contents are a positive unix timestamp; `db::now()` returns that instead of the
wall clock so a cron routine can be moved onto its next slot during a local
run. Leave it unset in normal use.

- Wake-ups never run in Plan mode (`wake_execution_mode`), because Plan mode
  blocks the Jean MCP tools. Cursor wakes use Yolo instead of Build
  (`wake_execution_mode_for`).
- When the agent has a backend, model, effort, or thinking level, the wake
  passes those on `send_chat_message`. Selected skills are appended to the
  wake message with the chat skill marker.
- New chat sessions get an implement execution mode saved once
  (`ensure_session_mode`). Plan is not that default. Old session JSON without
  a saved mode still loads as Plan so those sessions are not escalated.
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
inserts a `schedule` event and the tick delivers it to the chat. An event
wakes only the coordinator of the project it happened in (the project of the
session's or pull request's worktree, or of the coordinator that asked for the
approval). Delivery stops at `max_wakes_per_hour`. A spent budget leaves the
event queued; it is not dropped and it is not delivered early. These routines
do not add a hop.

The same occurrence is stored in `schedule_event_keys`, so a merged PR does
not queue twice. Session keys include the second they happened,
so each run of a session is a new occurrence. Changing the event type clears those
keys. Pausing does not.

| Event | Source | Not fired when |
|---|---|---|
| `session_finished` | `chat:done` | The session is a coordinator chat or an active delegation. Those already wake their coordinator, and a routine on them would loop. |
| `session_failed` | `chat:error` | Same exclusion. `chat:cancelled` is not a trigger. |
| `pr_merged` | `pr:status-update` whose `state` is `merged` | The same worktree and PR number already woke this routine. Open and closed PRs do not match. |
| `approval_resolved` | `decide_approval`, after the result is queued back to the requesting session | The approval id already woke this routine. |

Not included, on purpose:

- **Usage-limit reset.** Codex stores `reset_at` on a usage snapshot, but Jean
  does not emit an event when a window resets. Watching that would be a new
  poller, not a hook on something that already happens.
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

Coordinator-only tools: `schedule_create/update/list/cancel`, `memory_save/search/update/forget/supersede`, `journal_add/search`,
`notify_user` (emits `agents:notification` for the toast),
`set_status`, `ask_user`, `list_connectors`. `task_list` is removed.

These tools are listed only for a coordinator chat. `tools/list` is answered
by the Jean app, not by the stdio proxy: the proxy sends
`{"method":"tools/list","source":<JEAN_MCP_SESSION>}` over the local socket
and `jean_mcp_core::tools_list_for_source` returns the list for that session.
Every other session, and a proxy that cannot reach the app, gets the project
tools only (`set_connector` included). Calling a coordinator tool from another
session still fails in `mcp::run`.

`set_status` returns only `shown`: the chat
reads the latest call from the streamed tool calls and shows its 2-5 word text
in the status line (`agent-status.ts`). A Jean-tool allowlist cannot
block it. The caller is identified by `JEAN_MCP_SESSION`. Codex threads
get it per thread through a config override
(`jean_mcp_config::codex_session_config_override`), because the persistent
`~/.codex/config.toml` entry only has a fixed label.

**Agent messages in the chat:** an agent chat shows each
`send_chat_message` call as one "Messaged <target>" line, not as the full
text. When an agent session calls `send_chat_message`, the message starts with
`[Message from agent <name> (`<id>`)]` (`agents::agent_message_text`), so the
receiving session shows one "Message from <agent>" line. The tool result also
has `worktreeId`, `worktreePath`, `sessionName` and `worktreeName`. A click on
a line opens the conversation dialog (`AgentMessageLink.tsx`).

**Approval gate:** `delete_worktree`, `permanently_delete_worktree`,
`push_worktree`, `merge_pull_request`, `create_pull_request`,
`remove_project` and `set_connector` called from an
agent session are stored in `approvals` and not run. When the user approves,
`jean_mcp_core::run_approved_tool` runs the same call, and the result goes to
the agent as an event. The gate is in `call_tool`, so it works for every
backend and does not depend on the prompt. The agent chat shows each request
at the tool call that made it (`agentApprovalId` in `agent-messages.ts`,
`AgentApprovalInline`) as an `AgentQuestionCard` with Approve and Deny as the
options. The text uses worktree and agent names (`describeApproval`), not IDs
or raw arguments.

**Questions:** `ask_user` takes `question`, 2 to 8 `options`, and
`multiple`. The tool only validates and returns `shown`. The agent chat renders
the call input as `AgentQuestionCard`: one answer sends on click, multiple
answers send with a Send button (one `- option` line each). The answer is a
normal user message, so it works on every backend. The card is read-only once
the user writes a message after it (`nextUserAnswers`, automatic updates do not
count).

## Commands

Registered in `http_server/dispatch.rs` (`AGENT_COMMANDS`, served by
`dispatch_agents_command`), so native IPC and web access both work:
`get_project_coordinator`, `list_agents`, `get_agent_details`, `update_agent`, `decide_agent_approval`, `create_agent_schedule`,
`update_agent_schedule`, `cancel_agent_schedule`,
`save/search/update/delete/supersede/export_agent_memory`, `save/search_agent_journal`, `mark_agent_notifications_read`,
`get_agent_workdir`.
`create_agent_schedule` takes `kind` (`once`, `interval`, `cron`, `event`)
plus the fields for that kind (`delaySecs`, `everySecs`, `cron` + `timezone`,
or `event`). `update_agent_schedule` patches `name`, `prompt`, `paused`, and,
when `kind` is set, replaces the timing. Pause does not delete the routine.
Changes emit `cache:invalidate` with key `agents`.

`get_project_coordinator(projectId)` returns `{ agentId, worktreeId,
worktreePath, chatSessionId, backend, model, effort, thinkingLevel }`. It
creates the coordinator and its chat session when they do not exist, and a new
chat when the user closed the last one. The run fields are `null` when the
coordinator uses the defaults. The TypeScript wrapper is
`useProjectCoordinator` in `src/services/agents.ts`. `get_agent_workdir`
returns the project folder.

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
| OpenCode | project, home, and `~/.config/opencode` `opencode.json` / `.jsonc`: `mcp` object (1.x) and `mcp.servers` (2.x) | `opencode mcp list` |
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
the project folder as the worktree, which is where the agent session
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

`set_connector` (Jean MCP, needs approval) turns one discovered server on or
off in the list a settings page edits: `global` (preferences
`default_enabled_mcp_servers`), `project` (`enabled_mcp_servers`) or `agent`
(the connector limit above). It saves through `patch_preferences`,
`update_project_settings` or `update_agent`, so the UI gets the same cache
update as a UI save. Enable on a project or agent with no saved list starts a
list with only that server, like the settings switches. Jean does not store
server definitions (command, URL, env, headers); each backend CLI owns them.
The tool takes only backend and server name and never returns server config.

The settings section is **Connectors and tools** on the agent page. With no
saved MCP limit the switches are off (nothing is selected). Turning one on
starts the allowlist. Jean tool switches start on, because no limit means
every tool. Status badges are **Enabled**, **Off**, **Default**, **Needs
sign-in** (from `check_mcp_health`), and **Unsupported on this backend**.
Needs sign-in wins over Enabled so the sign-in button stays visible. Sign-in
is shown for Claude and Codex, which are the backends `prepare_mcp_login`
supports. Codex can sign in and still cannot apply the allowlist; the badge
says unsupported.
