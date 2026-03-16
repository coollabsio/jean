# HTTP Server for Jean Web Mode

## Goal

Enable Jean frontend to run in a browser via HTTP server, reusing existing UI while replacing Tauri IPC with REST API calls. Use HTTP polling instead of WebSockets for real-time updates.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Jean Rust Backend                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │  Tauri Commands │    │     HTTP Server (Axum)          │ │
│  │  (invoke)       │    │  - REST API endpoints           │ │
│  │                 │    │  - Static file serving          │ │
│  │   Native app    │    │  - 0.0.0.0:PORT                 │ │
│  └────────┬────────┘    └──────────────┬──────────────────┘ │
│           │                            │                     │
│           └───────────┬────────────────┘                     │
│                       ▼                                      │
│              Shared Command Logic                            │
│         (projects::commands, chat::commands, etc.)           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     React Frontend                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Transport Abstraction Layer                 ││
│  │  ┌─────────────────┐  ┌─────────────────────────────┐   ││
│  │  │ TauriTransport  │  │     HttpTransport           │   ││
│  │  │ (invoke)        │  │  (fetch + polling)          │   ││
│  │  └─────────────────┘  └─────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────┘│
│                            │                                 │
│                            ▼                                 │
│           TanStack Query + Services (unchanged)              │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Decisions

| Decision          | Choice                                |
| ----------------- | ------------------------------------- |
| Real-time updates | HTTP polling (no WebSocket)           |
| HTTP framework    | Axum                                  |
| Static files      | Embedded via `include_dir!`           |
| Auth              | Token-based, persisted in preferences |
| Binding           | 0.0.0.0 for LAN access                |
| Data sharing      | Shared with native app                |
| Terminal          | Excluded (needs WebSocket)            |
| Startup           | Manual toggle + auto-start option     |
| Port conflict     | Show error                            |

---

## Implementation Phases

### Phase 1: Rust HTTP Server

1. Add dependencies to `src-tauri/Cargo.toml`:

   ```toml
   axum = "0.8"
   tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync"] }
   tower = "0.5"
   tower-http = { version = "0.6", features = ["fs", "cors", "trace"] }
   include_dir = "0.7"
   ```

2. Create `src-tauri/src/http_server/`:
   - `mod.rs` - Server manager
   - `routes.rs` - Route definitions
   - `handlers.rs` - Thin wrappers around existing commands
   - `state.rs` - Shared app state
   - `streaming.rs` - In-memory streaming state for polling

3. REST endpoints:

   ```
   # All require: Authorization: Bearer <token>

   GET  /api/projects
   POST /api/projects
   GET  /api/projects/:id/worktrees

   GET  /api/sessions/:worktree_id
   POST /api/sessions/:worktree_id
   GET  /api/sessions/:id
   POST /api/sessions/:id/message
   GET  /api/sessions/:id/stream    # polling endpoint
   POST /api/sessions/:id/cancel

   GET  /api/git/:worktree_id/status
   GET  /api/pr/:worktree_id/status

   GET  /api/preferences
   PUT  /api/preferences
   ```

4. Streaming state for polling:
   ```rust
   struct StreamingState {
       content: String,
       tool_calls: Vec<ToolCall>,
       thinking: String,
       is_done: bool,
       error: Option<String>,
   }
   ```

### Phase 2: Frontend Transport Layer

1. Create `src/lib/transport.ts`:

   ```typescript
   interface Transport {
     call<T>(command: string, args?: Record<string, unknown>): Promise<T>
     subscribe(event: string, handler: (data: unknown) => void): () => void
   }

   export const transport: Transport = isTauri()
     ? new TauriTransport()
     : new HttpTransport()
   ```

2. HttpTransport gets token from URL or localStorage:

   ```typescript
   // e.g., http://192.168.1.100:3456?token=abc123
   const urlToken = new URLSearchParams(window.location.search).get('token')
   this.token = urlToken || localStorage.getItem('jean-http-token') || ''
   ```

3. Refactor services: `invoke()` → `transport.call()`

4. Update `useStreamingEvents`:
   - Tauri: existing event listeners
   - HTTP: poll `/api/sessions/{id}/stream` every 500ms

### Phase 3: Static File Serving

```rust
use include_dir::{include_dir, Dir};
static FRONTEND_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

Router::new()
    .nest("/api", api_routes)
    .fallback(serve_static_files)  // SPA fallback
```

### Phase 4: Settings UI

New "Web Access" section in Settings modal:

- Toggle: "Enable HTTP Server"
- Port input (default 3456)
- Status indicator (green/gray dot)
- Access URL (clickable)
- Auth Token (hidden, reveal + copy button)
- Auto-start checkbox

Tauri commands:

- `start_http_server(port) → { url, token }`
- `stop_http_server()`
- `get_http_server_status() → { running, url?, token?, port? }`

Preferences:

```rust
http_server_auto_start: bool,   // default: false
http_server_port: u16,          // default: 3456
http_server_token: Option<String>, // generated once, persisted
```

---

## Files

### New Rust

- `src-tauri/src/http_server/mod.rs`
- `src-tauri/src/http_server/routes.rs`
- `src-tauri/src/http_server/handlers.rs`
- `src-tauri/src/http_server/state.rs`
- `src-tauri/src/http_server/streaming.rs`

### Modified Rust

- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`

### New TypeScript

- `src/lib/transport.ts`
- `src/lib/http-transport.ts`
- `src/lib/tauri-transport.ts`

### Modified TypeScript

- `src/services/chat.ts`
- `src/services/projects.ts`
- `src/services/git-status.ts`
- `src/services/pr-status.ts`
- `src/services/preferences.ts`
- `src/components/chat/hooks/useStreamingEvents.ts`
- `src/components/settings/SettingsModal.tsx`

---

## Verification

1. Unit tests for transport layer
2. Integration test: start server, make API calls
3. Manual: enable server → open in browser → send chat → verify polling
