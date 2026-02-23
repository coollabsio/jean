# Jean API Documentation

This directory documents Jean's browser-accessible API surface in depth for building integrations (including MCP servers).

Scope:
- HTTP connectible endpoints
- WebSocket RPC protocol
- Realtime event channels
- Full WebSocket command inventory
- Skills/commands discovery (documented + hidden/undocumented)
- Native-only gaps and browser no-op behavior
- Practical MCP integration blueprint

Primary source-of-truth files:
- `src-tauri/src/http_server/server.rs`
- `src-tauri/src/http_server/websocket.rs`
- `src-tauri/src/http_server/dispatch.rs`
- `src/lib/transport.ts`
- `src-tauri/src/lib.rs`
- `src-tauri/src/projects/commands.rs`
- `src-tauri/src/chat/commands.rs`

Contents:
- `01-http-connectible-api.md`
- `02-websocket-rpc-protocol.md`
- `03-websocket-event-streams.md`
- `04-websocket-command-catalog.md`
- `05-skills-documented-and-undocumented.md`
- `06-native-vs-web-coverage.md`
- `07-mcp-server-integration-playbook.md`
- `08-regeneration-and-audit.md`
- `09-reverse-engineering-mcp-better-vibe-kanban.md`
- `10-jean-mcp-server-plan.md`
