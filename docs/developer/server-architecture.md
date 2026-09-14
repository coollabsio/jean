# Server architecture

Jean's browser/headless backend is split into a Tauri-free shared core and thin
runtime adapters:

```text
jean-core  -> runtime context, typed state, event bus, domains, dispatcher, Axum
src-server -> Tokio process bootstrap and shutdown handling
src-tauri  -> native desktop adapter and desktop-only OS integrations
```

`RuntimeContext` supplies application paths, typed managed state, and local
events without depending on a window runtime. The WebSocket broadcaster mirrors
those events to browser clients and retains the existing replay behavior. The
shared dispatcher remains the protocol compatibility boundary for browser
commands.

Native window, embedded browser, clipboard, picker, notification, and menu
operations stay desktop-only. Finder/editor/terminal open commands are gated:

- allowed automatically under WSL (Windows host tools via `explorer.exe` / CLI)
- allowed with `--allow-native-open` / `JEAN_ALLOW_NATIVE_OPEN=1`
- allowed when the desktop app hosts Web Access
- otherwise return an explicit "desktop app" error over HTTP

## Native multi-server client boundary

The native desktop client can keep independent connections to several Jean
servers. Each connection owns its WebSocket request map, listeners, replay
state, retry state, and health state. The selected legacy remote reuses its
existing transport so Jean does not create a duplicate socket.

Multi-server behavior is native-only. Browser Web Access continues to use one
HTTP/WebSocket backend at the origin that served the page. It must not start
the native connection manager, read cross-server resources, or show
multi-server aggregation controls.

Client-wide resource identity uses `(serverId, resourceId)`. The reserved
local server ID is `local`; server persistence does not add this field to
projects, worktrees, or sessions. Server capability responses publish API
protocol range `1..=1` and versioned named capabilities. Missing protocol
fields are read as the legacy protocol version 1.

Server paths never initialize a graphical toolkit; they only spawn existing host
tools when the gate above permits it.

## Required server gates

```bash
cargo tree --manifest-path src-server/Cargo.toml -p jean-server
env -u DISPLAY -u WAYLAND_DISPLAY jean-server --host 127.0.0.1 --port 3456
curl http://127.0.0.1:3456/readyz
ldd jean-server
```

The dependency tree and dynamic-library list must not contain Tauri, wry,
WebKitGTK, GTK, or AppIndicator.
