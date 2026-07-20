# Jean iOS Remote Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an iPhone/iPad Jean client that stores multiple remote Jean Web Access instances, connects to one instance at a time, and displays the existing mobile Jean UI without running a local Jean backend.

**Architecture:** Reuse the existing React UI, remote-connection profiles, HTTP bootstrap, and WebSocket transport inside a minimal Tauri v2 iOS shell. Compile desktop-only Rust, `jean-core`, CLI, terminal, browser-pane, updater, and window integrations out of the iOS target. Persist connection metadata locally, keep access tokens in iOS Keychain, and require an explicitly selected remote before application bootstrap begins.

**Tech Stack:** React 19, TypeScript, Vitest 4, Tauri 2.10, Rust, iOS WebKit, iOS Keychain, Axum HTTP/WebSocket.

## Product assumptions

- V1 opens the complete existing Jean mobile UI after the user selects a server; it is not a status-only dashboard.
- The iOS application is remote-only. It never offers `Local`, initializes `jean-core`, executes a CLI, or owns a repository.
- Multiple connection profiles are stored on the device, but exactly one is active.
- Non-development iOS connections require HTTPS/WSS. Desktop Jean continues accepting HTTP and HTTPS.
- Server-owned jobs continue when iOS disconnects or is suspended. The client refreshes persisted state after reconnecting.
- Push notifications, offline mutation queues, QR pairing, universal links, and App Store automation are excluded from V1. They are separate follow-up features.
- The first distribution target is TestFlight. iOS 16.0 is the minimum supported version.

## Global Constraints

- Use Tauri v2 APIs only.
- Preserve desktop native, browser Web Access, and headless `jean-server` behavior.
- Do not store Jean access tokens in `localStorage`, logs, URLs, analytics, or React Query caches on iOS.
- Do not add mobile fallbacks that pretend unsupported desktop commands succeeded.
- Do not cancel a server job merely because the iOS app disconnects, backgrounds, or switches instances.
- Keep mobile-only Rust dependencies under `cfg(target_os = "ios")` and desktop-only dependencies under `cfg(not(any(target_os = "android", target_os = "ios")))`.
- Use `isLocalBackend()` for local-backend capabilities and `isNativeApp()` only for shell capabilities available on both desktop and iOS.
- Register any new Tauri command in the active platform's `generate_handler![]`. Keychain commands are intentionally local-shell-only and must not be added to Web Access dispatch.
- Run `bun run check:all` after implementation and an Xcode simulator/device build before calling the feature complete.

---

## File map

**New focused units**

- `src/lib/client-mode.ts` — compile-time distinction between the desktop client and remote-only iOS client.
- `src/lib/connection-secrets.ts` — frontend adapter for iOS Keychain commands; contains no profile/UI state.
- `src/components/remote/MobileConnectionsScreen.tsx` — remote-only first-launch and instance-selection surface.
- `src-tauri/src/desktop.rs` — existing desktop/server Tauri runtime moved behind a desktop-only compilation gate.
- `src-tauri/src/mobile.rs` — minimal mobile Tauri builder and Keychain commands.
- `src-tauri/capabilities/mobile.json` — minimal iOS capability set.
- `src-tauri/tauri.ios.conf.json` — iOS identifier, frontend build mode, and iOS bundle settings.
- `docs/developer/ios-remote-client.md` — local development, signing, server prerequisites, and TestFlight smoke test.

**Existing units to extend**

- `src/lib/remote-connections.ts` — profile persistence, secure-token hydration, active selection.
- `src/lib/environment.ts` — remote-only clients never report a local backend.
- `src/lib/transport.ts` — require a configured remote and reconnect after iOS suspension.
- `src/App.tsx` — render connection setup before starting queries/listeners and gate local CLI checks.
- `src/components/remote/RemoteConnectionsDialog.tsx` — asynchronous secret-aware CRUD and no Local row on iOS.
- `src/components/remote/RemoteConnectionRecovery.tsx` — choose-another-server recovery for remote-only clients.
- `src/components/titlebar/TitleBar.tsx` — keep instance switching reachable on mobile.
- `src-tauri/src/lib.rs` and `src-tauri/Cargo.toml` — desktop/mobile compilation boundary.
- `jean-core/src/http_server/server.rs` — retain/test the iOS WebView origin in native-client CORS.

---

### Task 1: Define the remote-only client mode and iOS build entry points

**Files:**

- Create: `src/lib/client-mode.ts`
- Test: `src/lib/client-mode.test.ts`
- Create: `src-tauri/tauri.ios.conf.json`
- Modify: `package.json`

**Interfaces:**

- Produces: `ClientMode = 'desktop' | 'remote-only'`
- Produces: `getClientMode(): ClientMode`
- Produces: `isRemoteOnlyClient(): boolean`
- Consumes: Vite variable `VITE_JEAN_CLIENT_MODE=remote-only`

- [ ] **Step 1: Write the failing client-mode test**

```ts
// src/lib/client-mode.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('client mode', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to desktop', async () => {
    vi.stubEnv('VITE_JEAN_CLIENT_MODE', '')
    vi.resetModules()
    const { getClientMode, isRemoteOnlyClient } = await import('./client-mode')
    expect(getClientMode()).toBe('desktop')
    expect(isRemoteOnlyClient()).toBe(false)
  })

  it('recognizes the remote-only iOS build', async () => {
    vi.stubEnv('VITE_JEAN_CLIENT_MODE', 'remote-only')
    vi.resetModules()
    const { getClientMode, isRemoteOnlyClient } = await import('./client-mode')
    expect(getClientMode()).toBe('remote-only')
    expect(isRemoteOnlyClient()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `bun run test:run src/lib/client-mode.test.ts`

Expected: FAIL because `src/lib/client-mode.ts` does not exist.

- [ ] **Step 3: Implement the minimal client-mode module**

```ts
// src/lib/client-mode.ts
export type ClientMode = 'desktop' | 'remote-only'

export function getClientMode(): ClientMode {
  return import.meta.env.VITE_JEAN_CLIENT_MODE === 'remote-only'
    ? 'remote-only'
    : 'desktop'
}

export function isRemoteOnlyClient(): boolean {
  return getClientMode() === 'remote-only'
}
```

- [ ] **Step 4: Add explicit iOS scripts**

Add these `package.json` scripts without changing existing desktop scripts:

```json
{
  "ios:init": "VITE_JEAN_CLIENT_MODE=remote-only tauri ios init",
  "ios:dev": "VITE_JEAN_CLIENT_MODE=remote-only tauri ios dev --config src-tauri/tauri.ios.conf.json",
  "ios:build": "VITE_JEAN_CLIENT_MODE=remote-only tauri ios build --config src-tauri/tauri.ios.conf.json"
}
```

- [ ] **Step 5: Add the iOS configuration**

Create `src-tauri/tauri.ios.conf.json` as an override of `tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Jean",
  "identifier": "com.jean.mobile",
  "build": {
    "beforeDevCommand": "VITE_JEAN_CLIENT_MODE=remote-only bun run dev",
    "beforeBuildCommand": "VITE_JEAN_CLIENT_MODE=remote-only bun run build"
  },
  "bundle": {
    "iOS": {
      "minimumSystemVersion": "16.0"
    }
  }
}
```

- [ ] **Step 6: Initialize the generated Apple project**

Run: `bun run ios:init`

Expected: Tauri creates `src-tauri/gen/apple/` and prints the generated Xcode project location. Do not hand-create a git worktree.

- [ ] **Step 7: Re-run the focused test**

Run: `bun run test:run src/lib/client-mode.test.ts`

Expected: PASS for desktop default and remote-only mode.

- [ ] **Step 8: Commit the build-mode boundary**

```bash
git add package.json src/lib/client-mode.ts src/lib/client-mode.test.ts src-tauri/tauri.ios.conf.json src-tauri/gen/apple
git commit -m "feat(ios): add remote client build mode"
```

---

### Task 2: Split the desktop runtime from the minimal iOS shell

**Files:**

- Create: `src-tauri/src/mobile.rs`
- Create: `src-tauri/src/desktop.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Create: `src-tauri/capabilities/mobile.json`

**Interfaces:**

- Produces: `mobile::run()` for `cfg(mobile)`
- Preserves: existing desktop `run()` behavior for macOS, Windows, and Linux
- Produces local commands used in Task 3:
  - `save_mobile_connection_token(connection_id: String, token: String) -> Result<(), String>`
  - `load_mobile_connection_token(connection_id: String) -> Result<Option<String>, String>`
  - `delete_mobile_connection_token(connection_id: String) -> Result<(), String>`

- [ ] **Step 1: Move desktop-only dependencies behind a desktop target gate**

In `src-tauri/Cargo.toml`, keep only Tauri and plugins used by both shells in `[dependencies]`. Move `jean-core`, updater/process/window-state/fs/persisted-scope/clipboard dependencies, `dirs`, `tokio`, `image`, and `arboard` into the existing non-mobile target section. Add Keychain support only for iOS:

```toml
[target.'cfg(target_os = "ios")'.dependencies]
keyring = { version = "3", default-features = false, features = ["apple-native"] }

[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
jean-core = { path = "../jean-core" }
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
tauri-plugin-window-state = "2"
tauri-plugin-fs = "2"
tauri-plugin-persisted-scope = "2"
tauri-plugin-clipboard-manager = "2"
dirs = "5.0"
tokio = { version = "1", features = ["rt-multi-thread"] }
image = { version = "0.25", default-features = false, features = ["png"] }
arboard = { version = "3", features = ["wayland-data-control"] }
```

Keep `tauri-plugin-log`, `tauri-plugin-notification`, `tauri-plugin-dialog`, and `tauri-plugin-opener` shared only after confirming `cargo check` resolves their iOS implementations.

- [ ] **Step 2: Put the existing desktop implementation behind a non-mobile module boundary**

Move the current contents of `src-tauri/src/lib.rs`—except the public entry point and module declarations—into `src-tauri/src/desktop.rs`. Gate the existing crate-level modules so their current file paths remain valid. The resulting `src-tauri/src/lib.rs` is:

```rust
#[cfg(not(mobile))]
mod browser;
#[cfg(not(mobile))]
mod desktop;
#[cfg(not(mobile))]
mod desktop_commands;
#[cfg(not(mobile))]
mod http_server;
#[cfg(not(mobile))]
mod platform;

#[cfg(mobile)]
mod mobile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(mobile)]
    mobile::run();

    #[cfg(not(mobile))]
    desktop::run();
}
```

Make the moved `run()` in `desktop.rs` public within the crate and update moved module references to `crate::browser`, `crate::desktop_commands`, `crate::http_server`, and `crate::platform`. Do not leave a reference to `jean_core`, updater, browser panes, desktop commands, or server CLI arguments in the mobile compilation path.

- [ ] **Step 3: Create the minimal mobile builder and Keychain commands**

```rust
// src-tauri/src/mobile.rs
const KEYCHAIN_SERVICE: &str = "com.jean.mobile.remote-connections";

fn entry(connection_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, connection_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_mobile_connection_token(connection_id: String, token: String) -> Result<(), String> {
    entry(&connection_id)?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_mobile_connection_token(connection_id: String) -> Result<Option<String>, String> {
    match entry(&connection_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_mobile_connection_token(connection_id: String) -> Result<(), String> {
    match entry(&connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_mobile_connection_token,
            load_mobile_connection_token,
            delete_mobile_connection_token,
        ])
        .run(tauri::generate_context!())
        .expect("error running Jean iOS client");
}
```

- [ ] **Step 4: Restrict iOS capabilities to the shared mobile plugins**

Add `"platforms": ["macOS", "windows", "linux"]` to `src-tauri/capabilities/default.json` so its updater, process, filesystem, window-state, clipboard-manager, and child-webview permissions never apply to iOS. Create `src-tauri/capabilities/mobile.json`:

```json
{
  "identifier": "mobile-capability",
  "platforms": ["iOS"],
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default",
    "log:default",
    "notification:default"
  ]
}
```

- [ ] **Step 5: Install the iOS Rust targets and compile the shell**

Run:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios-sim
```

Expected: PASS without compiling `jean-core`, updater, browser-pane code, or desktop commands.

- [ ] **Step 6: Re-run the desktop Rust checks**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS with existing desktop behavior unchanged.

- [ ] **Step 7: Commit the runtime split**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/desktop.rs src-tauri/src/mobile.rs src-tauri/capabilities/default.json src-tauri/capabilities/mobile.json
git commit -m "feat(ios): add remote-only native shell"
```

---

### Task 3: Store iOS connection tokens in Keychain

**Files:**

- Create: `src/lib/connection-secrets.ts`
- Test: `src/lib/connection-secrets.test.ts`
- Modify: `src/lib/remote-connections.ts`
- Modify: `src/lib/remote-connections.test.ts`
- Modify: `src/main.tsx`

**Interfaces:**

- Produces:
  - `loadConnectionSecret(connectionId: string): Promise<string>`
  - `saveConnectionSecret(connectionId: string, token: string): Promise<void>`
  - `deleteConnectionSecret(connectionId: string): Promise<void>`
  - `initializeRemoteConnections(): Promise<void>`
- Changes to async:
  - `addRemoteConnection(input): Promise<RemoteConnection>`
  - `updateRemoteConnection(id, input): Promise<RemoteConnection>`
  - `removeRemoteConnection(id): Promise<void>`
- Preserves synchronous reads after initialization:
  - `getRemoteConnections()`
  - `getActiveRemoteConnection()`
  - `selectConnection(id)`

- [ ] **Step 1: Write failing tests for the Keychain adapter**

Mock `@tauri-apps/api/core` and verify the exact local commands and camelCase arguments:

```ts
expect(invoke).toHaveBeenCalledWith('save_mobile_connection_token', {
  connectionId: 'remote-1',
  token: 'secret',
})
expect(invoke).toHaveBeenCalledWith('load_mobile_connection_token', {
  connectionId: 'remote-1',
})
expect(invoke).toHaveBeenCalledWith('delete_mobile_connection_token', {
  connectionId: 'remote-1',
})
```

Also verify desktop mode never invokes a mobile Keychain command.

- [ ] **Step 2: Run the secret-store test and confirm failure**

Run: `bun run test:run src/lib/connection-secrets.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the isolated Keychain adapter**

Use a dynamic direct Tauri import, not `@/lib/transport`, because these commands always belong to the local iOS shell:

```ts
import { isRemoteOnlyClient } from './client-mode'

async function localInvoke<T>(command: string, args: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export async function loadConnectionSecret(id: string): Promise<string> {
  if (!isRemoteOnlyClient()) return ''
  return (
    (await localInvoke<string | null>('load_mobile_connection_token', {
      connectionId: id,
    })) ?? ''
  )
}

export async function saveConnectionSecret(
  id: string,
  token: string
): Promise<void> {
  if (!isRemoteOnlyClient()) return
  await localInvoke('save_mobile_connection_token', {
    connectionId: id,
    token,
  })
}

export async function deleteConnectionSecret(id: string): Promise<void> {
  if (!isRemoteOnlyClient()) return
  await localInvoke('delete_mobile_connection_token', { connectionId: id })
}
```

- [ ] **Step 4: Extend remote-connection tests for secure mobile persistence**

Add tests proving:

1. iOS persisted JSON contains `id`, `name`, and `url`, but not `token`.
2. `initializeRemoteConnections()` hydrates tokens before `getActiveRemoteConnection()` is used.
3. add/update/delete call the secret adapter.
4. desktop profiles preserve the current storage format and behavior.
5. a Keychain failure rejects the mutation and does not select a half-saved profile.

- [ ] **Step 5: Refactor the profile module around an initialization barrier**

Keep hydrated profiles in memory. For remote-only mode, serialize metadata with the token removed and resolve every token from Keychain during `initializeRemoteConnections()`. Save the Keychain secret before publishing a newly added or updated in-memory snapshot. Delete the secret before removing the metadata.

The persisted mobile shape must be:

```ts
interface PersistedMobileRemoteConnection {
  id: string
  name: string
  url: string
}
```

The transport-facing in-memory shape remains:

```ts
export interface RemoteConnection {
  id: string
  name: string
  url: string
  token: string
}
```

- [ ] **Step 6: Bootstrap secrets before rendering React**

Refactor `src/main.tsx` so the root renders only after profile initialization completes:

```tsx
import { initializeRemoteConnections } from './lib/remote-connections'

async function start() {
  await initializeRemoteConnections()
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <QueryClientProvider client={queryClient}>
      <App />
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  )
}

void start()
```

Render a fatal startup message if Keychain initialization rejects; do not silently continue with an empty token:

```tsx
void start().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <main className="flex min-h-dvh items-center justify-center p-6 text-center">
      <div>
        <h1 className="font-semibold">Jean could not access secure storage</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  )
})
```

- [ ] **Step 7: Run the secure-profile tests**

Run:

```bash
bun run test:run src/lib/connection-secrets.test.ts src/lib/remote-connections.test.ts
```

Expected: PASS, including the assertion that iOS `localStorage` contains no token.

- [ ] **Step 8: Commit secure profile storage**

```bash
git add src/lib/connection-secrets.ts src/lib/connection-secrets.test.ts src/lib/remote-connections.ts src/lib/remote-connections.test.ts src/main.tsx
git commit -m "feat(ios): protect remote tokens in Keychain"
```

---

### Task 4: Add the remote-only instance selection experience

**Files:**

- Create: `src/components/remote/MobileConnectionsScreen.tsx`
- Test: `src/components/remote/MobileConnectionsScreen.test.tsx`
- Modify: `src/components/remote/RemoteConnectionsDialog.tsx`
- Modify: `src/components/remote/RemoteConnectionsDialog.test.tsx`
- Modify: `src/components/remote/RemoteConnectionRecovery.tsx`
- Modify: `src/components/titlebar/TitleBar.tsx`
- Modify: `src/App.tsx`

**Interfaces:**

- Produces: `<MobileConnectionsScreen />`
- Consumes: async connection CRUD from Task 3
- Consumes: `isRemoteOnlyClient()` from Task 1
- Behavior: connection selection persists, marks an intentional switch, and reloads the frontend

- [ ] **Step 1: Write failing mobile selection tests**

Cover these user-visible cases:

```ts
it('shows saved remote instances without a Local row')
it('adds an HTTPS server and connects after the save resolves')
it('does not select a profile when secure save fails')
it('rejects non-HTTPS URLs in a production remote-only build')
it('allows editing and deleting a non-active server')
it('offers Choose another server instead of Switch to Local after failure')
```

For the add test, assert the sequence by resolving the mocked `addRemoteConnection()` promise manually and verifying `selectConnection()` is not called before resolution.

- [ ] **Step 2: Run the component tests and confirm failure**

Run:

```bash
bun run test:run src/components/remote/MobileConnectionsScreen.test.tsx src/components/remote/RemoteConnectionsDialog.test.tsx
```

Expected: FAIL because the mobile screen is missing and dialog mutations are synchronous.

- [ ] **Step 3: Implement the full-screen instance picker**

`MobileConnectionsScreen` must:

- Show the Jean name and concise “Connect to a Jean server” copy.
- List saved profiles with name, hostname, and active/selected state.
- Provide Add, Edit, Delete, and Connect actions.
- Await secure CRUD before changing selection or reloading.
- Disable repeated submit while a mutation is pending.
- Show the actual mutation/network validation error inline.
- Never render a Local option.

Use the existing `parseRemoteConnectionInput()` normalization. Add a `requireHttps` option so production remote-only mode accepts only `https:`; keep desktop behavior unchanged. Permit `http://127.0.0.1` and `http://localhost` only when `import.meta.env.DEV` is true for simulator development.

- [ ] **Step 4: Make the existing dialog secret-aware and remote-only-aware**

Convert submit/delete handlers to `async`, await mutations, and keep the dialog open on failure. When `isRemoteOnlyClient()` is true:

- Hide the Local row.
- Prevent deletion of the active profile until another is selected, or return to `MobileConnectionsScreen` after deletion.
- Label the trigger `Jean servers`.
- Leave token input blank when editing; blank means keep the stored Keychain value.

- [ ] **Step 5: Adapt recovery actions**

In `RemoteConnectionRecovery`, branch on `isRemoteOnlyClient()`:

- Desktop: retain Retry, Edit connection, Switch to Local.
- iOS: show Retry, Edit server, Choose another server.

“Choose another server” clears only the active selection and returns to the picker. It must not delete the saved profile or its token.

- [ ] **Step 6: Gate the main application before hooks that query a backend**

Split `App` into a small outer bootstrap and the existing connected application:

```tsx
export default function App() {
  if (isRemoteOnlyClient() && !getActiveRemoteConnection()) {
    return <MobileConnectionsScreen />
  }
  return <ConnectedApp />
}
```

The existing query hooks, streaming listeners, preload effect, and WebSocket connection must live inside `ConnectedApp`, so first launch does not issue requests against `tauri://localhost`.

- [ ] **Step 7: Keep server switching available after connection**

Render `RemoteConnectionsDialog` in the mobile title bar as well as desktop native mode. Ensure safe-area padding does not place the trigger under the iPhone status bar or Dynamic Island.

- [ ] **Step 8: Run the remote UI tests**

Run:

```bash
bun run test:run src/components/remote/MobileConnectionsScreen.test.tsx src/components/remote/RemoteConnectionsDialog.test.tsx src/lib/remote-connections.test.ts
```

Expected: PASS for first launch, async save failure, HTTPS validation, switching, and recovery.

- [ ] **Step 9: Commit the mobile connection UX**

```bash
git add src/App.tsx src/components/remote src/components/titlebar/TitleBar.tsx src/lib/remote-connections.ts src/lib/remote-connections.test.ts
git commit -m "feat(ios): add remote server selection"
```

---

### Task 5: Route all iOS application data through the selected remote

**Files:**

- Modify: `src/lib/environment.ts`
- Modify: `src/lib/environment.test.ts`
- Modify: `src/lib/transport.ts`
- Modify: `src/lib/transport.test.ts`
- Modify: `src/App.tsx`
- Test: `src/App.ios-remote.test.tsx`

**Interfaces:**

- Produces: `isLocalBackend() === false` for remote-only builds, even before selection
- Produces: `usesWebSocketBackend() === true` only when remote-only mode has a selected remote
- Preserves: desktop Local/remote switching and browser Web Access routing

- [ ] **Step 1: Write failing environment and transport tests**

Add a mode matrix covering:

| Shell           | Selected remote | Expected backend              |
| --------------- | --------------- | ----------------------------- |
| Desktop Tauri   | No              | Local IPC                     |
| Desktop Tauri   | Yes             | Remote HTTP/WebSocket         |
| Browser         | n/a             | Current-origin HTTP/WebSocket |
| Remote-only iOS | No              | Unconfigured; no transport    |
| Remote-only iOS | Yes             | Remote HTTP/WebSocket         |

Assert that iOS never invokes `dispatch_core_command` and that remote `/api/init`, `/api/files`, `/api/project-files`, and `/ws` URLs use the active profile's absolute base URL/token.

- [ ] **Step 2: Run the focused tests and confirm the incorrect local-backend behavior**

Run:

```bash
bun run test:run src/lib/environment.test.ts src/lib/transport.test.ts
```

Expected: FAIL because a native shell with no selected remote currently reports a local backend.

- [ ] **Step 3: Correct environment semantics**

Implement the following rules:

```ts
export const isLocalBackend = (): boolean =>
  !isRemoteOnlyClient() && isNativeApp() && getActiveRemoteConnection() === null

export const hasBackendTransport = (): boolean => {
  if (isRemoteOnlyClient()) return getActiveRemoteConnection() !== null
  return isLocalBackend() || _webAccessEnabled
}
```

Update `usesWebSocketBackend()` so an unconfigured remote-only client is not mistaken for current-origin Web Access. Throw `No Jean server selected.` if transport entry points are called before selection; this is a programming error protected by the outer `App` gate.

- [ ] **Step 4: Treat native remote disconnects like Web Access disconnects**

Remove the blanket `isNativeApp()` exclusion from the established-disconnect effect. Exclude only `isLocalBackend()`. On a remote disconnect:

1. capture reload state,
2. wait for foreground/online state,
3. reload the frontend,
4. recover from server-persisted state.

Do not keep an iOS WebSocket alive with background timers; iOS suspension is expected.

- [ ] **Step 5: Add iOS foreground recovery coverage**

In `src/lib/transport.test.ts`, simulate:

```ts
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  value: 'hidden',
})
document.dispatchEvent(new Event('visibilitychange'))

Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  value: 'visible',
})
document.dispatchEvent(new Event('visibilitychange'))
```

Assert a stale socket is closed and exactly one reconnect/reload path starts after foregrounding.

- [ ] **Step 6: Add an App regression test**

`src/App.ios-remote.test.tsx` must prove the unconfigured picker mounts without calling preload, WebSocket connect, CLI-status queries, or streaming listeners. With a selected profile, it must prove the connected app starts the remote preload/transport path.

- [ ] **Step 7: Run the complete transport matrix**

Run:

```bash
bun run test:run src/lib/environment.test.ts src/lib/transport.test.ts src/App.ios-remote.test.tsx src/App.web-reload-regression.test.ts
```

Expected: PASS for desktop local, desktop remote, browser, unconfigured iOS, configured iOS, and foreground reconnect.

- [ ] **Step 8: Commit transport routing**

```bash
git add src/App.tsx src/App.ios-remote.test.tsx src/lib/environment.ts src/lib/environment.test.ts src/lib/transport.ts src/lib/transport.test.ts
git commit -m "feat(ios): route client through remote transport"
```

---

### Task 6: Gate desktop-only capabilities from the iOS UI

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/components/titlebar/TitleBar.tsx`
- Modify: `src/lib/transport.ts`
- Modify: affected component tests discovered by the audit
- Create: `src/lib/client-capabilities.ts`
- Test: `src/lib/client-capabilities.test.ts`

**Interfaces:**

- Produces:
  - `canUseLocalBackendCommands(): boolean`
  - `canUseDesktopWindowFeatures(): boolean`
  - `canUseMobileNativeFeatures(): boolean`

- [ ] **Step 1: Inventory native/local checks before editing**

Run:

```bash
rg -n "isNativeApp\(|isLocalBackend\(|LOCAL_SHELL_COMMANDS|DESKTOP_ONLY_COMMANDS" src
```

Classify every match as local-backend, desktop-shell, or mobile-native. Record the classification in the Task 6 commit body; do not replace every `isNativeApp()` mechanically.

- [ ] **Step 2: Write the failing capability matrix test**

Test these outcomes:

```ts
expect(capabilities.desktopLocal.canUseLocalBackendCommands).toBe(true)
expect(capabilities.desktopRemote.canUseLocalBackendCommands).toBe(false)
expect(capabilities.iosRemote.canUseLocalBackendCommands).toBe(false)
expect(capabilities.iosRemote.canUseMobileNativeFeatures).toBe(true)
expect(capabilities.browser.canUseMobileNativeFeatures).toBe(false)
```

- [ ] **Step 3: Implement explicit capability helpers**

Keep the helper small and derived from client mode, native shell, and local backend. It must not duplicate individual backend feature lists.

```ts
export const canUseLocalBackendCommands = () => isLocalBackend()
export const canUseDesktopWindowFeatures = () =>
  isNativeApp() && !isRemoteOnlyClient()
export const canUseMobileNativeFeatures = () =>
  isNativeApp() && isRemoteOnlyClient()
```

- [ ] **Step 4: Fix startup checks that incorrectly use native-shell identity**

In `App.tsx`, enable local CLI installation/auth/version checks only when `canUseLocalBackendCommands()` is true. Remote server CLI status continues through normal remote query services where supported. Do not run desktop update checks, local HTTP-server startup, window state, embedded browser-pane initialization, or filesystem scope setup on iOS.

- [ ] **Step 5: Audit local-shell transport commands**

Keep only commands actually registered by the iOS builder callable as local-shell commands on iOS. Unsupported actions must be hidden/disabled by capabilities or return the existing explicit desktop-only error. Do not route Finder/editor/terminal/browser-pane/file-picker commands to the remote server as a fallback.

- [ ] **Step 6: Adapt title bar and safe areas**

On iOS:

- hide desktop window controls, desktop app version/update affordances, and keyboard shortcut hints,
- retain server picker, unread state, settings that affect the remote UI, and external-link opening,
- apply `env(safe-area-inset-top)` and horizontal safe-area padding.

- [ ] **Step 7: Run capability and affected component tests**

Run:

```bash
bun run test:run src/lib/client-capabilities.test.ts src/components/titlebar src/components/open-in src/hooks/useBrowserPane.test.tsx
```

Expected: PASS; iOS exposes only remote and supported mobile-native actions.

- [ ] **Step 8: Commit capability gating**

```bash
git add src/App.tsx src/components/titlebar/TitleBar.tsx src/lib/client-capabilities.ts src/lib/client-capabilities.test.ts src/lib/transport.ts
git add -u src
git commit -m "fix(ios): gate desktop-only capabilities"
```

---

### Task 7: Enforce iOS networking and server compatibility

**Files:**

- Modify: `src/lib/remote-connections.ts`
- Modify: `src/lib/remote-connections.test.ts`
- Modify: `jean-core/src/http_server/server.rs`
- Modify: `docs/headless-server.md`
- Modify: `src/components/remote/MobileConnectionsScreen.tsx`

**Interfaces:**

- Produces production iOS validation: HTTPS/WSS only
- Preserves desktop HTTP/HTTPS support
- Preserves default native origin: `tauri://localhost`

- [ ] **Step 1: Add failing scheme-policy tests**

Test that production remote-only parsing rejects `http://server.example`, accepts `https://server.example`, and that desktop parsing still accepts both. In development, accept only `http://localhost` and `http://127.0.0.1` as HTTP exceptions.

- [ ] **Step 2: Implement scheme policy as an explicit parser option**

Use an options object rather than reading build mode inside the generic parser:

```ts
interface ParseRemoteConnectionOptions {
  requireHttps?: boolean
  allowDevelopmentLoopback?: boolean
}
```

The mobile UI passes `{ requireHttps: true, allowDevelopmentLoopback: import.meta.env.DEV }`; desktop callers use the default options.

- [ ] **Step 3: Strengthen the existing native-origin Rust test**

Retain `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost` in `NATIVE_CLIENT_ORIGINS`. Add an Axum request test with `Origin: tauri://localhost` that reaches an authenticated endpoint and receives the expected CORS allow-origin header. Do not replace token authentication with CORS trust.

- [ ] **Step 4: Document secure exposure**

Update `docs/headless-server.md` with an iOS section covering:

- HTTPS reverse proxy as the production requirement,
- token authentication remaining mandatory,
- Caddy/Nginx examples already in the document,
- Tailscale Serve as the HTTPS option for private networks,
- development simulator loopback exception,
- the fact that backgrounding disconnects the client but not server jobs.

- [ ] **Step 5: Run networking tests**

Run:

```bash
bun run test:run src/lib/remote-connections.test.ts src/components/remote/MobileConnectionsScreen.test.tsx
cargo test --manifest-path jean-core/Cargo.toml http_server::server
```

Expected: PASS for scheme policy, token auth, and native-origin CORS.

- [ ] **Step 6: Commit network policy**

```bash
git add src/lib/remote-connections.ts src/lib/remote-connections.test.ts src/components/remote/MobileConnectionsScreen.tsx jean-core/src/http_server/server.rs docs/headless-server.md
git commit -m "feat(ios): enforce secure remote connections"
```

---

### Task 8: Verify the existing Jean UI on iPhone and iPad sizes

**Files:**

- Modify: only components with a reproduced mobile defect
- Test: matching colocated component tests
- Modify: `e2e/playwright.config.ts`
- Create: `e2e/ios-remote-client.spec.ts`

**Interfaces:**

- Consumes: existing responsive Jean UI and E2E mock transport
- Produces: deterministic browser-level coverage for the remote-only build mode

- [ ] **Step 1: Add iPhone and iPad E2E projects**

Configure Playwright projects with representative viewports:

```ts
{
  name: 'ios-iphone',
  use: { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true },
},
{
  name: 'ios-ipad',
  use: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
}
```

Run the E2E Vite server with `VITE_JEAN_CLIENT_MODE=remote-only` for this spec.

- [ ] **Step 2: Write the end-to-end remote-client flow**

Cover:

1. first launch shows server selection,
2. adding a server stores/selects it,
3. mocked HTTP bootstrap and WebSocket data render projects,
4. a session opens and accepts a message,
5. switching servers reloads without showing stale project/session data,
6. disconnect recovery can choose another server,
7. no Local/Finder/editor/terminal/browser-pane action is present.

- [ ] **Step 3: Run the new E2E test and fix only reproduced defects**

Run:

```bash
VITE_JEAN_CLIENT_MODE=remote-only bun run test:e2e -- e2e/ios-remote-client.spec.ts
```

Expected: PASS in both `ios-iphone` and `ios-ipad` projects.

- [ ] **Step 4: Perform simulator interaction checks**

Run: `bun run ios:dev`

In the iOS simulator verify:

- safe areas and rotation,
- software keyboard send/newline behavior,
- scrolling while a response streams,
- sheets/modals remain within the screen,
- copy/paste text,
- external links leave Jean via the system browser,
- background for 30 seconds, foreground, and recover current session state.

- [ ] **Step 5: Commit mobile UI verification fixes**

```bash
git add e2e/ios-remote-client.spec.ts e2e/playwright.config.ts src
git commit -m "test(ios): cover remote client workflows"
```

---

### Task 9: Document development and prepare a TestFlight build

**Files:**

- Create: `docs/developer/ios-remote-client.md`
- Modify: `README.md`
- Modify: generated Xcode signing/project files under `src-tauri/gen/apple/` only where Tauri requires checked-in settings

**Interfaces:**

- Produces repeatable local simulator, device, archive, and TestFlight instructions

- [ ] **Step 1: Write the iOS developer guide**

Document exact prerequisites and commands:

```bash
xcode-select --install
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
bun install
bun run ios:init
bun run ios:dev
bun run ios:build
```

Include bundle id `com.jean.mobile`, iOS 16.0 minimum, Apple development team selection, Keychain behavior, HTTPS requirement, simulator loopback, server setup, and device log collection from Xcode.

- [ ] **Step 2: Add a concise README entry**

Link to `docs/developer/ios-remote-client.md` and state that the iOS build is a remote client requiring an existing Jean desktop/headless server.

- [ ] **Step 3: Configure signing in the generated Xcode project**

Open the project printed by `bun run ios:init`, select the Jean iOS target, use automatic signing, select the coolLabs Apple developer team, and confirm the bundle id remains `com.jean.mobile`. Store no personal provisioning profile UUID in source control.

- [ ] **Step 4: Create an archive and upload to TestFlight**

Run `bun run ios:build`, open the generated Xcode workspace/project, choose **Any iOS Device (arm64)**, then use **Product → Archive → Distribute App → App Store Connect → Upload**.

Expected: App Store Connect accepts the archive without missing icon, privacy manifest, entitlement, or unsupported-architecture errors.

- [ ] **Step 5: Execute the TestFlight smoke test on a physical device**

Verify:

1. clean install opens server selection,
2. valid HTTPS URL/token connects,
3. relaunch restores the active profile and retrieves its token from Keychain,
4. wrong token shows recovery without leaking it,
5. server switch isolates project/session caches,
6. background/foreground reconnects and server work continues,
7. deleting the app removes local profile metadata; document that iOS Keychain items can survive uninstall and that V1 makes no reinstall-migration guarantee.

- [ ] **Step 6: Commit documentation and non-personal project metadata**

```bash
git add README.md docs/developer/ios-remote-client.md src-tauri/gen/apple
git commit -m "docs(ios): add remote client release guide"
```

---

### Task 10: Final verification

**Files:**

- No planned source changes; fix only failures attributable to this feature.

- [ ] **Step 1: Run focused frontend tests**

```bash
bun run test:run \
  src/lib/client-mode.test.ts \
  src/lib/client-capabilities.test.ts \
  src/lib/connection-secrets.test.ts \
  src/lib/remote-connections.test.ts \
  src/lib/environment.test.ts \
  src/lib/transport.test.ts \
  src/components/remote/MobileConnectionsScreen.test.tsx \
  src/components/remote/RemoteConnectionsDialog.test.tsx \
  src/App.ios-remote.test.tsx
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run the project quality gate**

Run: `bun run check:all`

Expected: TypeScript, ESLint, formatting, Rust formatting, Clippy, frontend tests, and Rust tests all PASS.

- [ ] **Step 3: Compile desktop and iOS targets**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios-sim
bun run build
bun run ios:build
```

Expected: desktop and iOS builds PASS; iOS does not compile/link `jean-core` or desktop-only plugins.

- [ ] **Step 4: Run remote-client E2E coverage**

Run:

```bash
VITE_JEAN_CLIENT_MODE=remote-only bun run test:e2e -- e2e/ios-remote-client.spec.ts
```

Expected: iPhone and iPad projects PASS.

- [ ] **Step 5: Inspect security-sensitive output**

Run:

```bash
rg -n 'jean-remote-connections|token' src/lib src/components/remote
git diff --check
git status --short
```

Confirm iOS persisted profile JSON and logs never contain access tokens, no personal signing material is staged, and only intended feature files changed.

- [ ] **Step 6: Perform a two-server physical-device smoke test**

Connect to server A, open a session, switch to server B, verify A data disappears, start/open a B session, switch back to A, and verify A's server-persisted state returns. Background Jean during an active server job and confirm the job completes independently.

- [ ] **Step 7: Record deferred follow-ups without expanding V1**

Create separate task files under `tasks-todo/` only for follow-ups the team chooses to pursue: push notifications, QR/deep-link pairing, offline queued prompts, App Store CI automation, and a lightweight monitoring-only home screen.
