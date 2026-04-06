# MCP Server Integration Playbook

This is a practical blueprint for exposing Jean Web API through MCP.

## Recommended architecture

1. `JeanWsClient`
- Handles `/api/auth` validation and `/ws` connection.
- Implements invoke correlation via request IDs.
- Central reconnect + token error state.

2. `JeanCommandAdapter`
- Maps MCP tools to Jean command names.
- Normalizes args and supports camel/snake aliases where relevant.
- Applies timeout/retry policy per command category.

3. `JeanEventBridge`
- Subscribes to event frames.
- Forwards selected streams as MCP notifications/resources.
- Performs reconciliation fetch after reconnect.

4. `CapabilityRegistry`
- Labels commands as:
  - Stable/public
  - Advanced/internal
  - Browser no-op
  - Native-only (not reachable over WS)

## Suggested first MCP tools

Session/chat:
- `get_sessions`
- `get_session`
- `create_session`
- `send_chat_message`
- `cancel_chat_message`

Projects/worktrees:
- `list_projects`
- `list_worktrees`
- `create_worktree`
- `archive_worktree`
- `unarchive_worktree`

Context/skills:
- `list_saved_contexts`
- `list_claude_skills`
- `list_claude_commands`

Infra:
- `get_http_server_status`
- `regenerate_http_token`

## Robustness guidance

Because event delivery is best-effort:
- Re-fetch canonical state on reconnect.
- Re-fetch after lag suspicion/timeouts.
- Use idempotent command wrappers where possible.

Suggested reconcile commands:
- `list_projects`
- `get_sessions`
- `get_session`
- `list_worktrees`

## Security guidance

- Prefer `localhost_only = true` if MCP runs on same machine.
- Keep `token_required = true`.
- Avoid logging token-bearing URLs.
- If token leaks, call `regenerate_http_token` and reconnect all clients.

## Version drift control

- Treat `src-tauri/src/http_server/dispatch.rs` as command truth.
- Keep a generated command index and diff it during upgrades.
- Audit native-vs-web deltas after each app update.
