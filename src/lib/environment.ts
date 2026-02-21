/**
 * Environment detection utilities.
 *
 * - isNativeApp(): true when running inside any Tauri desktop shell (server or client)
 * - isClientApp(): true when built as the Jean Client (thin remote client)
 * - isServerApp(): true when running as the full Jean server app with local backend
 * - hasBackend(): true when a backend is available (Tauri IPC or WS connection)
 *
 * Services should guard with hasBackend(), not isTauri().
 * UI should use isServerApp() to gate features requiring a local backend.
 * Use isNativeApp() only for native window features (zoom, traffic lights, clipboard).
 */

/** Running inside any Tauri desktop app (server or client). */
export const isNativeApp = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** True when built as the Jean Client (thin remote client). */
export const isClientApp = (): boolean =>
  import.meta.env.VITE_CLIENT_MODE === 'true' ||
  (typeof window !== 'undefined' && '__JEAN_CLIENT_MODE__' in window)

/** True when running as the full Jean server app with local backend. */
export const isServerApp = (): boolean => isNativeApp() && !isClientApp()

/** A backend is available (either Tauri IPC or WebSocket connection). */
export const hasBackend = (): boolean => {
  if (isServerApp()) return true // Local Tauri IPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__) return true
  // Browser or client mode: need WS
  return _wsConnected
}

// Internal flag set by WsTransport when connected
let _wsConnected = false
export const setWsConnected = (connected: boolean): void => {
  _wsConnected = connected
}
