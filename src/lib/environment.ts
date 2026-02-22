/**
 * Environment detection utilities.
 *
 * - isNativeApp(): true when running inside any Tauri desktop shell (server or client)
 * - isClientMode(): true when running in client mode (connecting to remote server)
 * - isServerMode(): true when running as the full Jean server app with local backend
 * - hasBackend(): true when a backend is available (Tauri IPC or WS connection)
 *
 * Services should guard with hasBackend(), not isTauri().
 * UI should use isServerMode() to gate features requiring a local backend.
 * Use isNativeApp() only for native window features (zoom, traffic lights, clipboard).
 */

/** Running inside any Tauri desktop app (server or client). */
export const isNativeApp = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** True when running in client mode (native Tauri app pointed at a remote server). */
export const isClientMode = (): boolean =>
  isNativeApp() &&
  typeof localStorage !== 'undefined' &&
  localStorage.getItem('jean-client-mode') === 'true'

/** True when running as the full Jean server app with local backend. */
export const isServerMode = (): boolean => isNativeApp() && !isClientMode()

/** Get the saved remote server URL (client mode). */
export const getClientServerUrl = (): string | null =>
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('jean-client-server-url')
    : null

/** A backend is available (either Tauri IPC, WebSocket connection, or E2E mock). */
export const hasBackend = (): boolean => {
  if (isServerMode()) return true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__)
    return true
  // Browser or client mode: need WS
  return _wsConnected
}

// Internal flag set by WsTransport when connected
let _wsConnected = false
export const setWsConnected = (connected: boolean): void => {
  _wsConnected = connected
}
