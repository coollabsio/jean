# jean-mcp-server

MCP stdio server that bridges to Jean's Web API (`/api/auth`, `/api/init`, `/ws`).

## What is implemented

- Phase 0 scaffold:
  - Standalone package
  - Environment-based config loader
  - Structured logger + normalized error helper
- Phase 1 transport core:
  - HTTP auth check via `/api/auth`
  - Optional init bootstrap via `/api/init`
  - WebSocket invoke/event client (`/ws`) with request correlation
  - Exponential reconnect (`1s` base, capped)
  - Auth-failure lockout behavior
- Initial v1 tool surface:
  - `jean_get_http_server_status`
  - `jean_regenerate_http_token`
  - `jean_list_projects`
  - `jean_list_worktrees`
  - `jean_get_worktree`
  - `jean_create_worktree`
  - `jean_archive_worktree`
  - `jean_unarchive_worktree`
  - `jean_get_sessions`
  - `jean_get_session`
  - `jean_create_session`
  - `jean_send_chat_message`
  - `jean_cancel_chat_message`
  - `jean_list_saved_contexts`
  - `jean_read_context_file`
  - `jean_list_claude_skills`
  - `jean_list_claude_commands`
- Phase 3 event/task bridge:
  - MCP task support for `jean_send_chat_message` when task mode is requested
  - Chat lifecycle mapping from Jean events (`chat:*`) to MCP task statuses
  - Automatic cancel forwarding (`tasks/cancel` -> `cancel_chat_message`)
- Phase 4 resources:
  - Resource handlers: list, templates, read, subscribe, unsubscribe
  - Resource URIs:
    - `jean://projects`
    - `jean://sessions`
    - `jean://saved-contexts`
    - `jean://skills/claude`
    - `jean://commands/claude`
  - Resource templates:
    - `jean://projects/{projectId}/worktrees`
    - `jean://worktrees/{worktreeId}/sessions?worktreePath={worktreePath}`
    - `jean://sessions/{sessionId}?worktreeId={worktreeId}&worktreePath={worktreePath}`
  - Event-driven invalidation via Jean websocket events and reconnect reconciliation

## Configuration

Environment variables:

- `JEAN_BASE_URL` (default: `http://127.0.0.1:3456`)
- `JEAN_TOKEN` (optional if Jean token auth is disabled)
- `JEAN_TIMEOUT_MS` (default: `60000`)
- `JEAN_RECONNECT_BASE_MS` (default: `1000`)
- `JEAN_RECONNECT_MAX_MS` (default: `30000`)
- `JEAN_CHAT_TASK_TTL_MS` (default: `900000`)
- `JEAN_CHAT_TASK_POLL_MS` (default: `1500`)
- `JEAN_CHAT_TASK_TIMEOUT_MS` (default: `600000`)
- `JEAN_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, default: `info`)

## Run

```bash
cd jean-mcp-server
npm install
npm run build
npm start
```

For local development:

```bash
cd jean-mcp-server
npm run dev
```
