# Remote Jean Connections Design

## Goal

Let the native Jean desktop client switch its entire application backend between Local and one saved remote Jean Web Access server.

## Decisions

- The title bar shows a connection/server icon immediately before Sponsor.
- Exactly one instance is active: Local or one remote.
- Add connections using either a full Web Access URL containing `?token=...` or separate URL and token fields.
- Accept HTTP and HTTPS without warnings.
- Restore the last selected instance after restart.
- An unavailable restored remote shows recovery actions: Retry, Edit connection, and Switch to Local. It never silently falls back.
- Switching disconnects only the client; jobs and terminals continue on the previous Jean.

## Architecture

The native shell remains local and owns connection profiles and instance selection. Shared Jean commands and events route through a switchable backend transport: Tauri core dispatch for Local and authenticated HTTP/WebSocket for remote instances. Switching persists the selection and reloads the frontend, which gives every instance fresh TanStack Query and Zustand state and prevents stale events crossing instance boundaries.

Connection profiles contain an id, display name, normalized HTTP(S) base URL, and token. Local is an immutable built-in profile. The desktop WebView stores profiles in its private local storage; tokens are removed from pasted URLs before persistence and never displayed after saving.

## User interface

The title-bar icon opens a dialog listing Local and saved remotes with connection status. Users can select, add, edit, or delete remotes. Selecting the active profile is a no-op. Deleting the active remote first switches to Local. A remote connection failure replaces application content with a recovery view while retaining the native title bar and connection dialog.

## Transport and capabilities

Remote HTTP bootstrap, file URLs, authentication, and WebSocket URLs use the selected absolute base URL. The server allows the standard Tauri desktop origins through CORS. Tauri CSP allows outbound HTTP(S) and WS(S). Native window and clipboard capabilities remain local; backend-side desktop operations are unavailable while a remote is active.

## Error handling

Invalid connection input is rejected before save. Authentication, network, and WebSocket errors appear in the recovery view. Retry recreates the remote transport attempt. Edit opens the selected profile. Switch to Local is always available. No operation on the previous backend is cancelled when switching.

## Testing

Unit tests cover URL/token normalization, profile persistence, active selection, transport routing/base URLs, and title-bar dialog behavior. Rust tests cover default CORS origins where practical. The full TypeScript/Rust quality gate and a manual two-instance smoke test verify integration.
