# Remote Jean Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the native Jean UI to switch between its local core and saved remote Jean Web Access servers.

**Architecture:** Add a small persisted connection-profile module and teach the existing transport to use an explicit remote base URL/token in native mode. Switching instances reloads the frontend to isolate all backend state. A title-bar dialog manages profiles and a recovery screen handles unavailable remotes.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri v2, Rust, Axum WebSocket/HTTP.

## Global Constraints

- Preserve existing Web Access behavior for browser clients.
- Support both HTTP and HTTPS without warnings.
- Do not cancel backend operations when switching.
- Do not commit unrelated existing worktree changes.

---

### Task 1: Connection profiles

**Files:**

- Create: `src/lib/remote-connections.ts`
- Test: `src/lib/remote-connections.test.ts`

- [ ] Write failing tests for full-URL token extraction, separate tokens, normalization, CRUD, and restored active selection.
- [ ] Run the focused test and confirm failure because the module is missing.
- [ ] Implement the minimal local profile store and subscription API.
- [ ] Run the focused test and confirm it passes.

### Task 2: Switchable transport

**Files:**

- Modify: `src/lib/transport.ts`
- Modify: `src/lib/environment.ts`
- Test: `src/lib/transport.test.ts`

- [ ] Write failing tests proving native shared commands use WebSocket when a remote is active and remote URLs are absolute.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Parameterize the existing WebSocket transport with the active base URL/token and add disconnect/retry behavior.
- [ ] Run focused transport tests and existing browser transport tests.

### Task 3: Connection UI and recovery

**Files:**

- Create: `src/components/remote/RemoteConnectionsDialog.tsx`
- Create: `src/components/remote/RemoteConnectionRecovery.tsx`
- Test: `src/components/remote/RemoteConnectionsDialog.test.tsx`
- Modify: `src/components/titlebar/TitleBar.tsx`
- Modify: `src/App.tsx`

- [ ] Write failing component tests for icon/dialog, adding via either input style, selection, and recovery actions.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the dialog, title-bar trigger, startup restoration, and recovery view.
- [ ] Run the focused component tests.

### Task 4: Server/browser permissions and documentation

**Files:**

- Modify: `jean-core/src/http_server/server.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `docs/headless-server.md`

- [ ] Add a failing Rust test for native Jean origins in the default CORS policy where feasible.
- [ ] Permit Tauri desktop origins and outbound HTTP(S)/WS(S) in the desktop CSP.
- [ ] Document connecting from a native Jean client.
- [ ] Run Rust and frontend focused checks.

### Task 5: Verification

- [ ] Run all focused remote-connection and transport tests.
- [ ] Run `bun run check:all`.
- [ ] Inspect `git diff` to ensure existing unrelated work remains intact.
- [ ] Smoke test switching Local → remote → Local and remote startup recovery.
