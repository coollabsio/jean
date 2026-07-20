import { getActiveRemoteConnection } from './remote-connections'

/**
 * Environment detection utilities.
 *
 * - isNativeApp(): true only when running inside the Tauri desktop shell
 * - hasBackend(): true while Tauri IPC or the browser WebSocket is connected
 * - hasBackendTransport(): true when a backend transport is configured, even
 *   while the browser WebSocket is still opening
 *
 * Service queries should guard with hasBackendTransport(); mutations that
 * must run immediately should guard with hasBackend().
 * UI should use isNativeApp() for local shell features and isLocalBackend()
 * for backend-side desktop features (Finder, external editors, etc.).
 */

/** Running inside the native Tauri desktop app with usable IPC.
 * Some mobile/web shells can expose a partial `__TAURI_INTERNALS__` object
 * without `invoke`; those must use the WebSocket transport instead. */
export const isNativeApp = (): boolean =>
  typeof window !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function'

/** Whether backend operations target this desktop app's local Jean core. */
export const isLocalBackend = (): boolean =>
  isNativeApp() && getActiveRemoteConnection() === null

/** A backend is available (either Tauri IPC, WebSocket connection, or E2E mock). */
export const hasBackend = (): boolean => {
  if (isLocalBackend()) return true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__)
    return true
  // In browser mode, check if we have WS connection info
  // (set when the transport connects)
  return _wsConnected
}

// Internal flag set by WsTransport when connected
let _wsConnected = false
let _webAccessEnabled = false
export const setWsConnected = (connected: boolean): void => {
  _wsConnected = connected
}

export const setWebAccessEnabled = (enabled: boolean): void => {
  _webAccessEnabled = enabled
}

/** Whether queries can use a configured backend transport.
 * Unlike hasBackend(), this stays true while web access is connecting so query
 * functions wait/fail instead of returning authoritative empty data. */
export const hasBackendTransport = (): boolean =>
  isLocalBackend() ||
  getActiveRemoteConnection() !== null ||
  _webAccessEnabled ||
  (typeof window !== 'undefined' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    !!(window as any).__JEAN_E2E_MOCK__)
