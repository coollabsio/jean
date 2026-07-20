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

Native window, embedded browser, clipboard, picker, notification, menu, and
Finder/editor operations stay desktop-only. Server calls to native-only command
paths return an explicit error instead of initializing a graphical toolkit.

## Required server gates

```bash
cargo tree --manifest-path src-server/Cargo.toml -p jean-server
env -u DISPLAY -u WAYLAND_DISPLAY jean-server --host 127.0.0.1 --port 3456
curl http://127.0.0.1:3456/readyz
ldd jean-server
```

The dependency tree and dynamic-library list must not contain Tauri, wry,
WebKitGTK, GTK, or AppIndicator.
