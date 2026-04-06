# Reverse Engineering: `mcp-better-vibe-kanban`

Repository analyzed: `https://github.com/yigitkonur/mcp-better-vibe-kanban`  
Commit inspected: `4e06b91`

## 1. What It Is (Architecture in Practice)

`mcp-better-vibe-kanban` is a compact MCP server with:
- 12 curated tools
- 5 resources with subscription support
- Task primitive support for long-running message execution
- Transport choices: `stdio` (default), streamable HTTP, and Cloudflare Worker variant

Core entrypoint: `src/index.ts`.

### Server creation pattern

It builds one `Server` with explicit capabilities:
- `tools`
- `resources` (`subscribe`, `listChanged`)
- `tasks` (`list`, `cancel`, and task-aware tool call requests)

Then it wires:
- `ListToolsRequestSchema` -> all tool metadata and input JSON schemas
- `CallToolRequestSchema` -> tool lookup, zod validation, handler invocation
- resource handlers + subscription manager

Files:
- `src/index.ts`
- `src/resources.ts`

## 2. Tool Contract Pattern (Important)

Every tool follows the same contract:
- `name`
- `description`
- `inputSchema` (Zod)
- `handler(args, extra)`

`extra` is consistently used for:
- Progress notifications (`notifications/progress`) via `extra._meta.progressToken`
- Task store integration (`extra.taskStore`) when available

Files:
- `src/tools/index.ts`
- `src/utils/progress.ts`

### Validation flow

Validation is centralized:
1. Server parses tool args with `tool.inputSchema.parse(args || {})`
2. Handler executes only after schema validation
3. Validation failure returns structured MCP error response

This prevents handler-level schema drift.

## 3. The 12 Tools (Exact Set)

From `src/tools/index.ts`:
- `get_context`
- `list_tasks`
- `create_task`
- `get_task`
- `update_task`
- `delete_task`
- `start_workspace_session`
- `list_sessions`
- `get_session`
- `send_message`
- `get_queue_status`
- `cancel_queue`

### Notable behavior worth copying

`send_message` is the best-designed pattern in the repo:
- Auto-detects executor from session if omitted
- Attempts immediate follow-up send
- If executor is busy/conflicted, auto-queues message (when `auto_queue` is true)
- If `extra.taskStore` exists, delegates to task-aware flow for async execution tracking

File:
- `src/tools/index.ts` (`send_message` tool)
- `src/tasks.ts` (task-aware polling + status mapping)

## 4. Resource Model

Resource URIs:
- `vibe://tasks`
- `vibe://context`
- `vibe://tasks/{taskId}`
- `vibe://sessions/{sessionId}`
- `vibe://sessions/{sessionId}/queue`

Subscription design:
- Poll on interval (`VIBE_RESOURCE_POLL_INTERVAL`, default 10000 ms)
- Compute SHA-256 hash for each resource payload
- Emit `resource updated` only when hash changes

This is a pragmatic low-complexity pattern for APIs without push/webhook support.

File:
- `src/resources.ts`

## 5. Task Primitive Integration

When task store exists:
- Tool call creates MCP task
- Background polling maps external process states to MCP task statuses:
  - running -> working
  - completed -> completed
  - failed -> failed
  - killed -> cancelled

Timeout and cancellation handling are explicit:
- Poll every 5s
- Stop after 10 minutes
- Fail task on timeout

File:
- `src/tasks.ts`

## 6. Transport Strategy

### STDIO
Default and simplest mode.

### HTTP streamable transport
Per-session server instances keyed by `mcp-session-id`.
- `POST /mcp` initializes session
- Subsequent requests reuse session ID
- `DELETE /mcp` closes session
- `GET /health` for health checks

### Cloudflare Worker variant
`src/worker.ts` re-registers tools for worker runtime; README notes progress/task limitations there.

## 7. Config and Reliability Choices

Env model (`src/config.ts`):
- `VIBE_PROJECT_ID` required UUID
- `VIBE_REPO_ID` optional UUID
- `VIBE_API_URL`, `VIBE_WORKSPACE_ID`, poll interval, transport mode, port

Reliability choice (`src/api/client.ts`):
- Uses `curl` subprocess (`spawnSync`) instead of Node fetch due to platform-specific networking reliability issues
- Tradeoff: blocks event loop but favors operational reliability in target environment

## 8. Practical Lessons for `jean-mcp-server`

Patterns to copy:
- Single canonical tool registry (`allTools`) + central validation
- Progress emitter abstraction decoupled from handlers
- Task-aware wrapper only for long-running operations
- Small curated v1 toolset instead of exposing everything at once
- Resource subscriptions with deterministic change detection

Patterns to adapt (not copy verbatim):
- `curl + spawnSync` transport hack is Vibe-specific; Jean should use async WebSocket client to local Jean server
- Vibe's project lock model should become Jean session/server lock model (token + host + optional active workspace)
