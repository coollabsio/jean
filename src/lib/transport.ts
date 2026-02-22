/**
 * Transport abstraction layer.
 *
 * Drop-in replacements for @tauri-apps/api/core invoke() and
 * @tauri-apps/api/event listen(). Routes through Tauri IPC when
 * running as a native app, or WebSocket when running in a browser.
 */

import { useSyncExternalStore } from 'react'
import {
  isNativeApp,
  isClientMode,
  isServerMode,
  getClientServerUrl,
  setWsConnected,
} from './environment'
import { generateId } from './uuid'

// ---------------------------------------------------------------------------
// File source URL conversion (drop-in for Tauri's convertFileSrc)
// ---------------------------------------------------------------------------

/**
 * Convert a filesystem path to a URL loadable by the webview.
 * Re-implements Tauri's convertFileSrc() as pure string manipulation
 * to avoid a static import of @tauri-apps/api/core (which crashes in
 * browser mode because it checks for __TAURI_INTERNALS__ on load).
 *
 * In browser mode, returns the path as-is (local images won't render,
 * but the app won't crash).
 */
export function convertFileSrc(filePath: string, protocol = 'asset'): string {
  if (!isServerMode()) return filePath
  const path = encodeURIComponent(filePath)
  return navigator.userAgent.includes('Windows')
    ? `https://${protocol}.localhost/${path}`
    : `${protocol}://localhost/${path}`
}

/** Unlisten function type — compatible with Tauri's UnlistenFn. */
export type UnlistenFn = () => void

// ---------------------------------------------------------------------------
// Public API (same signatures as Tauri)
// ---------------------------------------------------------------------------

/**
 * Call a backend command. Drop-in replacement for Tauri's invoke().
 */
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  // E2E mock transport — route to in-memory handlers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e2eMock = (window as any).__JEAN_E2E_MOCK__
  if (e2eMock) {
    const handler = e2eMock.invokeHandlers[command]
    if (handler) return handler(args) as T
    console.warn(`[E2E] No mock for command: ${command}`)
    return null as T
  }

  if (isServerMode()) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    return tauriInvoke<T>(command, args)
  }
  return wsTransport.invoke<T>(command, args)
}

/**
 * Listen for backend events. Drop-in replacement for Tauri's listen().
 * Returns an unlisten function.
 */
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  // E2E mock transport — route to in-memory event emitter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e2eMock = (window as any).__JEAN_E2E_MOCK__
  if (e2eMock) {
    const et = e2eMock.eventEmitter as EventTarget
    const wrapped = (e: Event) =>
      handler({ payload: (e as CustomEvent).detail })
    et.addEventListener(event, wrapped)
    return () => et.removeEventListener(event, wrapped)
  }

  if (isServerMode()) {
    const { listen: tauriListen } = await import('@tauri-apps/api/event')
    return tauriListen<T>(event, handler)
  }
  return wsTransport.listen<T>(event, handler)
}

// ---------------------------------------------------------------------------
// Initial data preloading (used in browser mode)
// ---------------------------------------------------------------------------

export interface InitialData {
  projects: unknown[]
  worktreesByProject: Record<string, unknown[]>
  sessionsByWorktree: Record<string, unknown> // worktreeId -> WorktreeSessions
  activeSessions?: Record<string, unknown> // sessionId -> Session (with messages)
  preferences: unknown
  uiState: unknown
}

let initialDataPromise: Promise<InitialData | null> | null = null
let initialDataResolved = false

/**
 * Preload initial data via HTTP before WebSocket connects.
 * This allows the web view to show content immediately instead of
 * waiting for WebSocket connection + command round-trip.
 *
 * Returns null if preloading fails (app will fall back to WebSocket).
 */
export async function preloadInitialData(): Promise<InitialData | null> {
  if (isServerMode()) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__)
    return null
  // Client mode with no URL configured yet — nothing to preload
  if (isClientMode() && !getClientServerUrl()) return null
  if (initialDataPromise) return initialDataPromise

  initialDataPromise = (async () => {
    const origin = getServerOrigin()
    const urlToken = new URLSearchParams(window.location.search).get('token')
    const token = urlToken || localStorage.getItem('jean-http-token') || ''

    try {
      const url = token
        ? `${origin}/api/init?token=${encodeURIComponent(token)}`
        : `${origin}/api/init`
      const response = await fetch(url)
      if (!response.ok) {
        return null
      }
      const data = await response.json()
      initialDataResolved = true
      return data as InitialData
    } catch {
      return null
    }
  })()

  return initialDataPromise
}

/**
 * Check if initial data has been preloaded.
 */
export function hasPreloadedData(): boolean {
  return initialDataResolved
}

/**
 * Get the preloaded initial data if available (non-blocking).
 */
export function getPreloadedData(): InitialData | null {
  if (!initialDataResolved || !initialDataPromise) return null
  // Since initialDataResolved is true, the promise has resolved
  let result: InitialData | null = null
  initialDataPromise.then(data => {
    result = data
  })
  return result
}

/** Clear cached preload state (used when switching modes/servers). */
export function resetPreloadCache(): void {
  initialDataPromise = null
  initialDataResolved = false
}

// ---------------------------------------------------------------------------
// Server origin helper
// ---------------------------------------------------------------------------

/** Return the server origin for HTTP/WS connections. */
function getServerOrigin(): string {
  if (isClientMode()) {
    const url = getClientServerUrl()
    if (url) return url.replace(/\/$/, '')
  }
  return window.location.origin
}

// ---------------------------------------------------------------------------
// WebSocket Transport (used in browser and client modes)
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface WsMessage {
  type: 'response' | 'error' | 'event'
  id?: string
  data?: unknown
  error?: string
  event?: string
  payload?: unknown
}

class WsTransport {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private queue: { data: string; resolve: () => void }[] = []
  private _connected = false
  private _connecting = false
  private _authError: string | null = null
  private _subscribers = new Set<() => void>()

  get connected(): boolean {
    return this._connected
  }

  get authError(): string | null {
    return this._authError
  }

  private setConnected(value: boolean): void {
    this._connected = value
    setWsConnected(value)
    this.notifySubscribers()
  }

  private setAuthError(error: string | null): void {
    this._authError = error
    this.notifySubscribers()
  }

  private notifySubscribers(): void {
    for (const cb of this._subscribers) cb()
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback)
    return () => this._subscribers.delete(callback)
  }

  /** Get current connection snapshot for useSyncExternalStore. */
  getSnapshot(): boolean {
    return this._connected
  }

  /** Get current auth error snapshot for useSyncExternalStore. */
  getAuthErrorSnapshot(): string | null {
    return this._authError
  }

  /** Connect to the WebSocket server (validates token first). */
  connect(): void {
    if (
      this._connecting ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return

    // Read token from URL query param or localStorage
    const urlToken = new URLSearchParams(window.location.search).get('token')
    const token = urlToken || localStorage.getItem('jean-http-token') || ''

    // Persist token from URL to localStorage for future page loads
    if (urlToken) {
      localStorage.setItem('jean-http-token', urlToken)

      // Remove token from URL for security (prevent history/bookmark exposure)
      const url = new URL(window.location.href)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.toString())
    }

    // Validate token via HTTP before establishing WebSocket
    this._connecting = true
    this.validateAndConnect(token).finally(() => {
      this._connecting = false
    })
  }

  private async validateAndConnect(token: string): Promise<void> {
    const origin = getServerOrigin()
    const authUrl = token
      ? `${origin}/api/auth?token=${encodeURIComponent(token)}`
      : `${origin}/api/auth`

    try {
      const res = await fetch(authUrl)
      if (!res.ok) {
        // Invalid token — clear it, set error, don't reconnect
        localStorage.removeItem('jean-http-token')
        this.setAuthError(
          token
            ? "Invalid access token. Check the URL in Jean's Web Access settings."
            : "No access token provided. Use the URL from Jean's Web Access settings."
        )
        return
      }
    } catch {
      // Server unreachable — schedule reconnect (not an auth error)
      this.setAuthError(null)
      this.scheduleReconnect()
      return
    }

    // Token valid (or not required) — clear any previous auth error and connect
    this.setAuthError(null)
    this.connectWs(token)
  }

  private connectWs(token: string): void {
    // Derive WS URL from server origin
    const origin = getServerOrigin()
    const wsOrigin = origin.replace(/^http/, 'ws')
    const url = `${wsOrigin}/ws?token=${encodeURIComponent(token)}`

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.setConnected(true)
      this.reconnectAttempt = 0

      // Flush queued messages
      for (const item of this.queue) {
        this.ws?.send(item.data)
        item.resolve()
      }
      this.queue = []
    }

    this.ws.onmessage = event => {
      try {
        const msg: WsMessage = JSON.parse(event.data)
        this.handleMessage(msg)
      } catch {
        // Ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      this.setConnected(false)
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  /** Call a backend command over WebSocket. */
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const id = generateId()
    const data = JSON.stringify({
      type: 'invoke',
      id,
      command,
      args: args || {},
    })

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Command '${command}' timed out after 60s`))
      }, 60_000)

      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
      })

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(data)
      } else {
        // Queue for when connection is established
        this.queue.push({
          data,
          resolve() {
            /* noop */
          },
        })
        this.connect()
      }
    })
  }

  /** Register an event listener. Returns an unlisten function. */
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const typedHandler = handler as (event: { payload: unknown }) => void
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.listeners.get(event)!.add(typedHandler)

    // Ensure connected
    this.connect()

    return () => {
      this.listeners.get(event)?.delete(typedHandler)
      if (this.listeners.get(event)?.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.type === 'response' && msg.id) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(msg.id)
        pending.resolve(msg.data)
      }
    } else if (msg.type === 'error' && msg.id) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(msg.id)
        pending.reject(new Error(msg.error || 'Unknown error'))
      }
    } else if (msg.type === 'event' && msg.event) {
      const handlers = this.listeners.get(msg.event)
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler({ payload: msg.payload })
          } catch (e) {
            console.error(`[WsTransport] Error in '${msg.event}' handler:`, e)
          }
        }
      }
    }
  }

  /** Disconnect cleanly — clears timers, rejects pending, closes socket. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const [, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Disconnected from server'))
    }
    this.pending.clear()
    this.queue = []
    if (this.ws) {
      this.ws.onclose = null // prevent auto-reconnect
      this.ws.close()
      this.ws = null
    }
    this.setConnected(false)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    // Don't reconnect if there's an auth error — user needs to fix the token
    if (this._authError) return

    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000)
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

// Singleton instance
const wsTransport = new WsTransport()

// Auto-connect in browser mode and client mode (skip when E2E mocks are active)
if (
  typeof window !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  !(window as any).__JEAN_E2E_MOCK__
) {
  if (!isNativeApp()) {
    wsTransport.connect() // Browser mode: always
  } else if (isClientMode() && getClientServerUrl()) {
    wsTransport.connect() // Client mode: only when URL is saved
  }
}

// ---------------------------------------------------------------------------
// React hooks for connection status (browser mode only)
// ---------------------------------------------------------------------------

const subscribe = (cb: () => void) => wsTransport.subscribe(cb)
const getSnapshot = () => wsTransport.getSnapshot()
const getAuthErrorSnapshot = () => wsTransport.getAuthErrorSnapshot()

// E2E mock: always report connected, no auth errors
const isE2eMocked =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof window !== 'undefined' && !!(window as any).__JEAN_E2E_MOCK__
// eslint-disable-next-line @typescript-eslint/no-empty-function
const noopSubscribe = () => () => {}

/**
 * React hook that returns the current WebSocket connection status.
 * Only meaningful in browser mode (!isNativeApp()).
 */
export function useWsConnectionStatus(): boolean {
  return useSyncExternalStore(
    isE2eMocked ? noopSubscribe : subscribe,
    isE2eMocked ? () => true : getSnapshot
  )
}

/**
 * React hook that returns the current auth error message, or null if none.
 * Only meaningful in browser mode (!isNativeApp()).
 */
export function useWsAuthError(): string | null {
  return useSyncExternalStore(
    isE2eMocked ? noopSubscribe : subscribe,
    isE2eMocked ? () => null : getAuthErrorSnapshot
  )
}

// ---------------------------------------------------------------------------
// Client mode connection helpers
// ---------------------------------------------------------------------------

/** Connect to a remote Jean server. Saves config and reloads. */
export function connectToServer(serverUrl: string, token?: string): void {
  localStorage.setItem('jean-client-mode', 'true')
  localStorage.setItem('jean-client-server-url', serverUrl)
  if (token) {
    localStorage.setItem('jean-http-token', token)
  } else {
    localStorage.removeItem('jean-http-token')
  }
  window.location.reload()
}

/** Disconnect from remote server and return to local mode. Reloads. */
export function disconnectFromServer(): void {
  localStorage.removeItem('jean-client-mode')
  localStorage.removeItem('jean-client-server-url')
  localStorage.removeItem('jean-http-token')
  wsTransport.disconnect()
  window.location.reload()
}
