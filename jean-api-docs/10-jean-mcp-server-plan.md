# Plan: `jean-mcp-server`

This plan is derived from:
- `jean-api-docs/01-http-connectible-api.md`
- `jean-api-docs/02-websocket-rpc-protocol.md`
- `jean-api-docs/03-websocket-event-streams.md`
- `jean-api-docs/04-websocket-command-catalog.md`
- `jean-api-docs/06-native-vs-web-coverage.md`
- `jean-api-docs/09-reverse-engineering-mcp-better-vibe-kanban.md`

## 1. Goal and Guardrails

Goal:
- Build an MCP server that connects to Jean's Web API (HTTP + WebSocket) and exposes a safe, high-value tool/resource surface.

Guardrails:
- Prefer safe, deterministic commands for v1.
- Exclude browser no-op and native-only command gaps in v1.
- Use event-driven updates plus state reconciliation for correctness.

## 2. Target Architecture

## 2.1 `JeanWsClient`

Responsibilities:
- Auth check via `/api/auth`
- Bootstrap via `/api/init`
- WebSocket connect to `/ws`
- Request/response correlation (`id`)
- Reconnect with backoff
- Token management and auth-error state

Source basis:
- `jean-api-docs/01-http-connectible-api.md`
- `jean-api-docs/02-websocket-rpc-protocol.md`

## 2.2 `JeanCommandAdapter`

Responsibilities:
- MCP tool -> Jean command mapping
- Arg normalization (camel/snake aliases where needed)
- Per-command timeout and retry strategy
- Normalized MCP error payloads

Source basis:
- `jean-api-docs/04-websocket-command-catalog.md`

## 2.3 `JeanEventBridge`

Responsibilities:
- Subscribe to Jean events (`chat:*`, `worktree:*`, `git:*`, `pr:*`, sync events)
- Forward as MCP notifications / resource invalidation
- Trigger reconciliation fetch after reconnect or lag suspicion

Source basis:
- `jean-api-docs/03-websocket-event-streams.md`

## 2.4 `JeanTaskTracker`

Responsibilities:
- Optional MCP task primitive support for long-running actions (`send_chat_message`)
- Track completion/failure via event stream:
  - Start: `chat:sending`
  - Progress: `chat:chunk` / `chat:tool_use` / `chat:thinking`
  - Terminal: `chat:done` / `chat:error` / `chat:cancelled`

Pattern borrowed from:
- `mcp-better-vibe-kanban` task-aware send flow

## 2.5 `CapabilityRegistry`

Responsibilities:
- Classify each mapped command:
  - `stable_v1`
  - `advanced_v2`
  - `excluded_noop`
  - `excluded_native_only`
- Single source-of-truth for tool exposure policy

Source basis:
- `jean-api-docs/06-native-vs-web-coverage.md`

## 3. v1 Tool Surface (Recommended)

Keep v1 focused on strong read/write primitives that are proven in web mode.

## 3.1 Session and Chat

- `jean_get_sessions` -> `get_sessions`
- `jean_get_session` -> `get_session`
- `jean_create_session` -> `create_session`
- `jean_send_chat_message` -> `send_chat_message`
- `jean_cancel_chat_message` -> `cancel_chat_message`

## 3.2 Project / Worktree

- `jean_list_projects` -> `list_projects`
- `jean_list_worktrees` -> `list_worktrees`
- `jean_get_worktree` -> `get_worktree`
- `jean_create_worktree` -> `create_worktree`
- `jean_archive_worktree` -> `archive_worktree`
- `jean_unarchive_worktree` -> `unarchive_worktree`

## 3.3 Context / Skills

- `jean_list_saved_contexts` -> `list_saved_contexts`
- `jean_read_context_file` -> `read_context_file`
- `jean_list_claude_skills` -> `list_claude_skills`
- `jean_list_claude_commands` -> `list_claude_commands`

## 3.4 Server/Health

- `jean_get_http_server_status` -> `get_http_server_status`
- `jean_regenerate_http_token` -> `regenerate_http_token`

## 4. v1 Resources

Initial resource URIs:
- `jean://projects` (from `list_projects`)
- `jean://projects/{projectId}/worktrees` (from `list_worktrees`)
- `jean://worktrees/{worktreeId}/sessions` (from `get_sessions`)
- `jean://sessions/{sessionId}` (from `get_session`)
- `jean://saved-contexts` (from `list_saved_contexts`)
- `jean://skills/claude` (from `list_claude_skills`)
- `jean://commands/claude` (from `list_claude_commands`)

Subscription behavior:
- Mark resource dirty on matching event channels.
- Recompute content on read.
- Optional polling fallback if no event yet.

## 5. Explicit Exclusions for v1

Exclude commands known as browser no-op or unsupported over WS:
- Open-in-native actions (`open_worktree_in_*`, `open_file_in_default_app`)
- Terminal command family (`start_terminal`, `terminal_write`, etc.)
- Native drag-drop image path (`save_dropped_image`)
- WS `stop_http_server` call (returns designed error)

Also exclude native-only commands not routed in dispatch:
- Codex CLI management via native-only handlers
- Git identity handlers
- MCP discovery native handlers not currently in WS dispatch
- Other commands listed in `06-native-vs-web-coverage.md`

## 6. Execution Phases

## Phase 0: Scaffold
- Create package and MCP server skeleton
- Add config loader (`JEAN_BASE_URL`, `JEAN_TOKEN`, `JEAN_TIMEOUT_MS`)
- Add logger and structured error helper

## Phase 1: Transport Core
- Implement `/api/auth`, `/api/init`, `/ws` client
- Implement invoke request map and timeout handling
- Add reconnect and auth-failure behavior

Exit criteria:
- Can call `get_http_server_status`, `list_projects`, `get_sessions` reliably

## Phase 2: v1 Tools
- Implement tool registry + zod schemas
- Implement the v1 tool list above
- Add capability flags

Exit criteria:
- End-to-end MCP tool calls work for sessions/projects/chat basic flow

## Phase 3: Events + Tasks
- Add event bridge
- Add task-aware wrapping for `jean_send_chat_message`
- Add reconciliation on reconnect

Exit criteria:
- Long chat calls provide observable lifecycle and terminal outcome

## Phase 4: Resources
- Add resource list/templates/read
- Add optional subscriptions with invalidation

Exit criteria:
- Resources update correctly with event-driven changes

## 7. Acceptance Criteria

- Tool schemas are explicit and validated.
- No-op/native-only commands are not exposed as usable tools.
- Server remains stable under reconnect and transient auth/network errors.
- `send_chat_message` has a clear task lifecycle or equivalent progress semantics.
- Documented command map is generated from `dispatch.rs` and checked in.

## 8. Initial Implementation File Layout (Proposed)

```text
jean-mcp-server/
  src/
    index.ts
    config.ts
    transport/
      jean-http-auth.ts
      jean-ws-client.ts
    tools/
      index.ts
      sessions.ts
      projects.ts
      chat.ts
      contexts.ts
      skills.ts
      server.ts
    resources/
      index.ts
      manager.ts
    tasks/
      chat-task-tracker.ts
    utils/
      errors.ts
      progress.ts
      logger.ts
  README.md
```

## 9. Open Questions Before Coding

- Should v1 support only local Jean (`localhost_only`) or remote host URLs too?
- Should `send_chat_message` return immediately with task tracking by default, or block until done?
- Which subset of chat events should be surfaced as MCP notifications vs hidden internal telemetry?
