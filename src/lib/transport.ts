/**
 * Transport abstraction layer.
 *
 * Drop-in replacements for @tauri-apps/api/core invoke() and
 * @tauri-apps/api/event listen(). Routes through Tauri IPC when
 * running as a native app, or WebSocket when running in a browser.
 */

import { useSyncExternalStore } from 'react'
import { isNativeApp, setWebAccessEnabled, setWsConnected } from './environment'
import { generateId } from './uuid'
import { isServerWindows } from './platform'
import { getActiveRemoteConnection } from './remote-connections'
import { prepareRemoteEditorOpenArgs } from './remote-editor'
import { warnRemoteVersionMismatch } from './remote-version'

export function usesWebSocketBackend(): boolean {
  return !isNativeApp() || getActiveRemoteConnection() !== null
}

function getWebBackendBaseUrl(): string {
  return getActiveRemoteConnection()?.url ?? window.location.origin
}

function getWebBackendToken(): string {
  const remote = getActiveRemoteConnection()
  if (remote) return remote.token
  const urlToken = new URLSearchParams(window.location.search).get('token')
  return urlToken || localStorage.getItem('jean-http-token') || ''
}

function backendUrl(path: string): string {
  const base = `${getWebBackendBaseUrl().replace(/\/+$/, '')}/`
  return new URL(path.replace(/^\/+/, ''), base).toString()
}

function fetchBackend(url: string): Promise<Response> {
  if (!getActiveRemoteConnection()) return fetch(url)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  return fetch(url, { signal: controller.signal }).finally(() =>
    clearTimeout(timeout)
  )
}

// ---------------------------------------------------------------------------
// File source URL conversion (drop-in for Tauri's convertFileSrc)
// ---------------------------------------------------------------------------

// Cache for the server's app data directory path (set from init data or hook).
// Used by convertFileSrc in browser mode to build /api/files/ URLs.
let _appDataDir: string | null = null

/** Set the app data directory path for browser-mode file URL conversion. */
export function setAppDataDir(dir: string): void {
  // Normalize: ensure trailing separator for reliable startsWith matching
  _appDataDir = dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`
}

/**
 * Convert a filesystem path to a URL loadable by the webview.
 * Re-implements Tauri's convertFileSrc() as pure string manipulation
 * to avoid a static import of @tauri-apps/api/core (which crashes in
 * browser mode because it checks for __TAURI_INTERNALS__ on load).
 *
 * In browser mode, converts to /api/files/ URLs served by the HTTP server.
 */
export function convertFileSrc(filePath: string, protocol = 'asset'): string {
  if (!usesWebSocketBackend()) {
    // Use Tauri's native implementation which correctly percent-encodes paths
    // on all platforms (JS encodeURIComponent misses dots/hyphens/underscores
    // that Tauri's Rust encoder expects on Windows).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = (window as any).__TAURI_INTERNALS__
    if (internals?.convertFileSrc) {
      return internals.convertFileSrc(filePath, protocol)
    }
    // Fallback (should not reach in native app)
    const path = encodeURIComponent(filePath)
    return isServerWindows()
      ? `https://${protocol}.localhost/${path}`
      : `${protocol}://localhost/${path}`
  }

  // Browser mode: convert server filesystem path to /api/files/ URL
  const token = getWebBackendToken()
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  const base = getActiveRemoteConnection()?.url ?? ''

  // Try exact prefix match with cached app data dir
  if (_appDataDir && filePath.startsWith(_appDataDir)) {
    const relativePath = filePath.substring(_appDataDir.length)
    return `${base}/api/files/${encodeURI(relativePath)}${params}`
  }

  // Fallback: detect app data dir marker in path (works before _appDataDir is set)
  for (const marker of ['com.jean.desktop/', 'com.jean.desktop\\']) {
    const idx = filePath.indexOf(marker)
    if (idx !== -1) {
      const relativePath = filePath.substring(idx + marker.length)
      return `${base}/api/files/${encodeURI(relativePath)}${params}`
    }
  }

  // Last resort: return as-is (will likely not render, but won't crash)
  return filePath
}

/**
 * Convert an absolute project/worktree file path to a browser-loadable URL.
 * Native mode can use Tauri's asset protocol directly; browser mode uses the
 * authenticated project-file endpoint, which validates the path against known
 * project/worktree roots before serving it.
 */
export function convertProjectFileSrc(filePath: string): string {
  if (!usesWebSocketBackend()) {
    return convertFileSrc(filePath)
  }

  const token = getWebBackendToken()
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  const base = getActiveRemoteConnection()?.url ?? ''
  return `${base}/api/project-files/${encodeURIComponent(filePath)}${params}`
}

/** Unlisten function type — compatible with Tauri's UnlistenFn. */
export type UnlistenFn = () => void

function containNativeUnlisten(
  unlisten: () => void | Promise<void>
): UnlistenFn {
  let active = true
  return () => {
    if (!active) return
    active = false
    try {
      void Promise.resolve(unlisten()).catch(() => {
        // Page teardown can remove Tauri's listener registry first.
      })
    } catch {
      // Page teardown can remove Tauri's listener registry first.
    }
  }
}

const DESKTOP_ONLY_COMMANDS = new Set([
  'set_window_vibrancy',
  'send_native_notification',
  'read_clipboard_image',
  'write_clipboard_text',
  'save_dropped_image',
  'open_file_in_default_app',
  'open_worktree_in_finder',
  'open_project_worktrees_folder',
  'open_worktree_in_terminal',
  'open_worktree_in_editor',
  'open_project_on_github',
  'open_branch_on_github',
  'open_log_directory',
  'set_project_avatar',
  'start_http_server',
  'stop_http_server',
  'install_remote_jean_server',
  'browser_create',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_stop',
  'browser_set_bounds',
  'browser_set_visible',
  'browser_set_focus',
  'browser_get_url',
  'browser_close',
  'browser_report_title',
  'browser_enable_grab',
  'browser_report_grab_context',
  'get_active_browser_tabs',
  'has_active_browser_tab',
])

// These commands belong to the local desktop shell even when its application
// content is connected to a remote Jean backend.
const LOCAL_SHELL_COMMANDS = new Set([
  'set_window_vibrancy',
  'send_native_notification',
  'read_clipboard_image',
  'write_clipboard_text',
  // Quit confirmation must query the local process registry — remote sessions
  // survive client exit, and the remote WS may be down while loading/switching.
  'has_running_sessions',
  'install_remote_jean_server',
  'browser_create',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_stop',
  'browser_set_bounds',
  'browser_set_visible',
  'browser_set_focus',
  'browser_get_url',
  'browser_close',
  'browser_report_title',
  'browser_enable_grab',
  'browser_report_grab_context',
  'get_active_browser_tabs',
  'has_active_browser_tab',
])

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

  // Native app + remote Jean: open remote paths in local Zed via ssh://.
  // Must stay on the local Tauri shell (not the remote WebSocket dispatch).
  if (isNativeApp() && usesWebSocketBackend()) {
    const remote = getActiveRemoteConnection()
    if (remote) {
      const remapped = prepareRemoteEditorOpenArgs(command, args, remote)
      if (remapped) {
        const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
        return tauriInvoke<T>(command, remapped)
      }
    }
  }

  if (
    !usesWebSocketBackend() ||
    (isNativeApp() && LOCAL_SHELL_COMMANDS.has(command))
  ) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    if (DESKTOP_ONLY_COMMANDS.has(command)) {
      return tauriInvoke<T>(command, args)
    }
    return tauriInvoke<T>('dispatch_core_command', {
      command,
      args: args ?? {},
    })
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

  if (!usesWebSocketBackend()) {
    const { listen: tauriListen } = await import('@tauri-apps/api/event')
    const unlisten = await tauriListen<T>(event, handler)
    return containNativeUnlisten(unlisten)
  }
  return wsTransport.listen<T>(event, handler)
}

/** Listen for events emitted by the local desktop shell, even when connected
 * to a remote Jean backend. Browser clients have no local shell. */
export async function listenLocal<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  if (!isNativeApp()) return listen(event, handler)
  const { listen: tauriListen } = await import('@tauri-apps/api/event')
  const unlisten = await tauriListen<T>(event, handler)
  return containNativeUnlisten(unlisten)
}

/**
 * Request buffered terminal events from the backend. Used by browser-mode
 * terminal reattachment after a full page refresh, when in-memory sequence
 * tracking was lost but the Rust PTY and replay buffer are still alive.
 */
export function requestTerminalReplay(terminalId: string, lastSeq = 0): void {
  if (!usesWebSocketBackend()) return
  wsTransport.requestTerminalReplay(terminalId, lastSeq)
}

// ---------------------------------------------------------------------------
// Initial data preloading (used in browser mode)
// ---------------------------------------------------------------------------

export interface InitialData {
  projects?: unknown[]
  // Tiered payload: worktrees/sessions are present only for the selected
  // project; other projects are lazy-loaded by TanStack Query hooks on
  // navigation.
  worktreesByProject?: Record<string, unknown[]>
  sessionsByWorktree?: Record<string, unknown> // worktreeId -> WorktreeSessions
  activeSessions?: Record<string, unknown> // sessionId -> Session (with messages)
  runningSessions?: string[] // sessionIds with active CLI processes
  replayEvents?: BootstrapEvent[]
  preferences?: unknown
  uiState?: unknown
  appDataDir?: string
  serverPlatform?: 'mac' | 'windows' | 'linux'
  /** Server can launch host editor/finder/terminal (WSL or --allow-native-open). */
  nativeOpenAllowed?: boolean
  webBuildId?: string
  appVersion?: string
}

let initialDataPromise: Promise<InitialData | null> | null = null
let initialDataResolved = false

/**
 * Build the /api/init URL with the given query params.
 * Centralizes token and selected_project encoding.
 */
function buildInitUrl(opts: { selectedProjectId?: string | null }): string {
  const token = getWebBackendToken()
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (opts.selectedProjectId) {
    params.set('selected_project', opts.selectedProjectId)
  }
  const qs = params.toString()
  const url = backendUrl('api/init')
  return qs ? `${url}?${qs}` : url
}

/**
 * Preload initial data via HTTP before WebSocket connects.
 * This allows the web view to show content immediately instead of
 * waiting for WebSocket connection + command round-trip.
 *
 * Returns null if preloading fails (app will fall back to WebSocket).
 *
 * @param selectedProjectId - Browser's currently-selected project id.
 *   Sent so the server scopes the init payload to just that project's
 *   worktrees/sessions. Falls back to `ui_state.json` on disk when absent.
 */
export async function preloadInitialData(
  selectedProjectId?: string | null
): Promise<InitialData | null> {
  if (!usesWebSocketBackend()) return null
  setWebAccessEnabled(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__)
    return null
  if (initialDataPromise) return initialDataPromise

  initialDataPromise = (async () => {
    try {
      const url = buildInitUrl({ selectedProjectId })
      const response = await fetchBackend(url)
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

// ---------------------------------------------------------------------------
// WebSocket Transport (used in browser mode)
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface WsMessage {
  type: 'response' | 'error' | 'event' | 'heartbeat'
  id?: string
  data?: unknown
  error?: string
  event?: string
  payload?: unknown
  /** Monotonic sequence number for replay deduplication. */
  seq?: number
}

export interface BootstrapEvent {
  type: 'event'
  event: string
  payload: unknown
  seq?: number
}

class WsTransport {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >()
  private connectRetryAttempt = 0
  private connectRetryTimer: ReturnType<typeof setTimeout> | null = null
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Periodic check that we're seeing inbound traffic from the server.
   *  The server sends app-level heartbeats every 20s because browser JS cannot
   *  observe protocol ping/pong frames, so a 50s gap means the connection is dead. */
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private _lastInbound = 0
  private queue: { data: string; resolve: () => void }[] = []
  // Buffer for events that arrive before listeners are registered.
  // Covers the ~16ms gap between WS onopen and React effect listener setup.
  private eventBuffer = new Map<
    string,
    { msg: WsMessage; bufferedAt: number }[]
  >()
  private static readonly EVENT_BUFFER_MAX_AGE = 5_000
  private static readonly EVENT_BUFFER_MAX_SIZE = 50
  private _connected = false
  private _hasConnectedOnce = false
  private _connecting = false
  private _authError: string | null = null
  private _subscribers = new Set<() => void>()
  private _establishedDisconnectListeners = new Set<() => void>()
  private _connectEnabled = false
  /** Track last seen sequence numbers to deduplicate bootstrap replay. */
  private _lastSeqBySession = new Map<string, number>()
  /** Track terminal sequence numbers for explicit full-refresh replay. */
  private _lastSeqByTerminal = new Map<string, number>()

  constructor() {
    // Mobile browsers suspend background tabs and freeze JS timers. Check the
    // socket immediately on wake so a stale established connection triggers
    // the app reload without waiting for the periodic liveness timer.
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleWake)
      window.addEventListener('online', this.handleWake)
      window.addEventListener('pageshow', this.handleWake)
    }
  }

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

  onEstablishedDisconnect(callback: () => void): () => void {
    this._establishedDisconnectListeners.add(callback)
    return () => this._establishedDisconnectListeners.delete(callback)
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
    if (!this._connectEnabled) return
    // Established connections recover through a full page reload, never a
    // second in-memory WebSocket connection.
    if (this._hasConnectedOnce && !this._connected) return
    if (
      this._connecting ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return

    const remote = getActiveRemoteConnection()
    // Read token from URL query param or localStorage
    const urlToken = new URLSearchParams(window.location.search).get('token')
    const token =
      remote?.token || urlToken || localStorage.getItem('jean-http-token') || ''

    // Persist token from URL to localStorage for future page loads
    if (!remote && urlToken) {
      localStorage.setItem('jean-http-token', urlToken)

      // Remove token from URL for security (prevent history/bookmark exposure)
      const url = new URL(window.location.href)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.toString())
    }

    this._connecting = true

    this.validateAndConnect(token).finally(() => {
      this._connecting = false
    })
  }

  enableConnect(): void {
    if (this._connectEnabled) return
    this._connectEnabled = true
    this.connect()
  }

  private async validateAndConnect(token: string): Promise<void> {
    const authBaseUrl = backendUrl('api/auth')
    const authUrl = token
      ? `${authBaseUrl}?token=${encodeURIComponent(token)}`
      : authBaseUrl
    const remote = getActiveRemoteConnection()

    try {
      const res = await fetchBackend(authUrl)
      if (!res.ok) {
        // Invalid token — clear it and wait for the user to provide another.
        if (!remote) {
          localStorage.removeItem('jean-http-token')
        }
        this.setAuthError(
          token
            ? "Invalid access token. Check the URL in Jean's Web Access settings."
            : "No access token provided. Use the URL from Jean's Web Access settings."
        )
        return
      }

      // Native desktop UI is bundled with the client; warn (do not block)
      // when remote appVersion differs so users can still connect.
      if (remote && isNativeApp()) {
        try {
          const body = (await res.json()) as { appVersion?: string | null }
          warnRemoteVersionMismatch(body.appVersion)
        } catch {
          // Older servers or non-JSON auth bodies: allow connect.
        }
      }
    } catch {
      if (remote) {
        this.setAuthError(
          "Jean could not reach the server's authentication endpoint. Check that the server is running and the URL and port are correct. If the address opens in a browser, update and restart the remote Jean server so it allows desktop connections (CORS)."
        )
        return
      }
      // The initial page load may race server startup. Retry connecting until
      // the first successful socket; established sockets use a page reload.
      this.setAuthError(null)
      this.scheduleConnectRetry()
      return
    }

    // Token valid (or not required) — clear any previous auth error and connect
    this.setAuthError(null)
    this.connectWs(token)
  }

  private connectWs(token: string): void {
    const base = new URL(backendUrl('ws'))
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    base.searchParams.set('token', token)
    const url = base.toString()

    this.ws = new WebSocket(url)
    this.clearConnectWatchdog()
    this.connectWatchdog = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        console.warn(
          '[WsTransport] WebSocket connect watchdog fired, retrying connection'
        )
        try {
          this.ws.close()
        } catch {
          // Ignore close errors; the initial-connect retry handles recovery.
        }
      }
    }, WsTransport.CONNECT_TIMEOUT)

    this.ws.onopen = () => {
      this.clearConnectWatchdog()
      this._lastInbound = Date.now()
      this.startLivenessTimer()
      this._hasConnectedOnce = true
      this.setConnected(true)
      this.connectRetryAttempt = 0

      // Flush queued messages
      for (const item of this.queue) {
        this.ws?.send(item.data)
        item.resolve()
      }
      this.queue = []
    }

    this.ws.onmessage = event => {
      this._lastInbound = Date.now()
      try {
        const msg: WsMessage = JSON.parse(event.data)
        this.handleMessage(msg)
      } catch {
        // Ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      const wasConnected = this._connected

      if (wasConnected) {
        for (const callback of this._establishedDisconnectListeners) {
          try {
            callback()
          } catch (error) {
            console.error(
              '[WsTransport] Established disconnect listener failed:',
              error
            )
          }
        }
      }

      this.clearConnectWatchdog()
      this.stopLivenessTimer()
      this.ws = null

      this.setConnected(false)
      if (wasConnected && getActiveRemoteConnection()) {
        this.setAuthError('Connection to the selected Jean server was lost.')
      }

      // Clear event buffer — stale events from a dead connection
      // must not be delivered when the next connection opens.
      this.eventBuffer.clear()

      // Reject all pending command promises immediately — the server
      // response will never arrive on this socket. Prevents waiting
      // the full timeout (up to 10 min for long-running commands).
      for (const [, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('WebSocket disconnected'))
      }
      this.pending.clear()

      // Clear queued-but-unsent messages so a later page bootstrap cannot
      // spawn duplicate CLI processes.
      this.queue = []

      if (!wasConnected && !this._hasConnectedOnce) {
        this.scheduleConnectRetry()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  // Commands that spawn/attach to long-lived processes or are critical to
  // terminal lifecycle. These get an extended timeout instead of the default
  // 60s so idle connection edges do not falsely fail terminal sessions.
  private static readonly LONG_RUNNING_COMMANDS: ReadonlySet<string> = new Set([
    'send_chat_message',
    'run_review_with_ai',
    'create_pr_with_ai_content',
    'create_commit_with_ai',
    'execute_summarization',
    'install_claude_cli',
    'install_codex_cli',
    'install_opencode_cli',
    'install_pi_cli',
    'install_gh_cli',
    'install_coderabbit_cli',
    'update_coderabbit_cli',
    'run_coderabbit_review',
    'trigger_coderabbit_pr_review',
    'start_terminal',
    'terminal_write',
    'terminal_resize',
    'stop_terminal',
    'get_active_terminals',
    'has_active_terminal',
    'get_terminal_listening_ports',
  ])
  private static readonly LONG_TIMEOUT = 30 * 60_000
  private static readonly DEFAULT_TIMEOUT = 60_000
  private static readonly CONNECT_TIMEOUT = 12_000
  private static readonly MAX_QUEUE_SIZE = 500
  /** If no inbound traffic for this long, assume connection is dead.
   *  Must exceed the server's app-level heartbeat interval (20s); protocol
   *  ping/pong alone is not visible to browser JavaScript. */
  private static readonly INBOUND_TIMEOUT = 50_000
  private static readonly LIVENESS_CHECK_INTERVAL = 10_000

  /** Call a backend command over WebSocket. */
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const id = generateId()
    const data = JSON.stringify({
      type: 'invoke',
      id,
      command,
      args: args || {},
    })

    const timeoutMs = WsTransport.LONG_RUNNING_COMMANDS.has(command)
      ? WsTransport.LONG_TIMEOUT
      : WsTransport.DEFAULT_TIMEOUT

    return new Promise<T>((resolve, reject) => {
      if (this._authError) {
        reject(new Error(this._authError))
        return
      }

      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(`Command '${command}' timed out after ${timeoutMs / 1000}s`)
        )
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
      })

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(data)
      } else {
        if (this.queue.length >= WsTransport.MAX_QUEUE_SIZE) {
          clearTimeout(timeout)
          this.pending.delete(id)
          reject(
            new Error(
              `Command queue is full (${WsTransport.MAX_QUEUE_SIZE}). Restarting connection...`
            )
          )
          this.restartConnectionAttempt()
          return
        }

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

  /** Request buffered terminal output after a full page refresh. */
  requestTerminalReplay(terminalId: string, lastSeq = 0): void {
    const currentLastSeq = this._lastSeqByTerminal.get(terminalId)
    const effectiveLastSeq =
      currentLastSeq == null ? lastSeq : Math.max(lastSeq, currentLastSeq)
    this._lastSeqByTerminal.set(terminalId, effectiveLastSeq)

    const payload = JSON.stringify({
      type: 'terminal_replay',
      terminal_id: terminalId,
      last_seq: effectiveLastSeq,
    })

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload)
      return
    }

    if (this._connectEnabled) {
      this.connect()
    }
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

    // Drain buffered events that arrived before this listener was registered
    // (covers the gap between WS onopen and React effect listener setup)
    const buffered = this.eventBuffer.get(event)
    if (buffered && buffered.length > 0) {
      this.eventBuffer.delete(event)
      const now = Date.now()
      for (const { msg, bufferedAt } of buffered) {
        if (now - bufferedAt > WsTransport.EVENT_BUFFER_MAX_AGE) continue
        try {
          typedHandler({ payload: msg.payload })
        } catch (e) {
          console.error(`[WsTransport] Error draining buffered '${event}':`, e)
        }
      }
    }

    // Ensure connected once bootstrap explicitly enables it
    if (this._connectEnabled) {
      this.connect()
    }

    return () => {
      this.listeners.get(event)?.delete(typedHandler)
      if (this.listeners.get(event)?.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.type === 'heartbeat') {
      // onmessage already refreshed _lastInbound. No listener dispatch.
      return
    }

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
      // Track sequence numbers for bootstrap/live overlap deduplication.
      if (msg.seq != null && msg.payload) {
        const payload = msg.payload as Record<string, unknown>
        const sessionId = payload.session_id as string | undefined
        if (sessionId) {
          const lastSeen = this._lastSeqBySession.get(sessionId)
          if (lastSeen != null && msg.seq <= lastSeen) {
            return // Already processed — skip duplicate from replay
          }
          this._lastSeqBySession.set(sessionId, msg.seq)
          if (msg.event === 'chat:done' || msg.event === 'chat:cancelled') {
            this._lastSeqBySession.delete(sessionId)
          }
        }

        // Track terminal sequence numbers for explicit full-refresh replay.
        const terminalId = payload.terminal_id as string | undefined
        if (terminalId && msg.event.startsWith('terminal:')) {
          const lastSeen = this._lastSeqByTerminal.get(terminalId)
          if (lastSeen != null && msg.seq <= lastSeen) {
            return // Duplicate from replay — skip
          }
          this._lastSeqByTerminal.set(terminalId, msg.seq)
          if (msg.event === 'terminal:stopped') {
            this._lastSeqByTerminal.delete(terminalId)
          }
        }
      }

      const handlers = this.listeners.get(msg.event)
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          try {
            handler({ payload: msg.payload })
          } catch (e) {
            console.error(`[WsTransport] Error in '${msg.event}' handler:`, e)
          }
        }
      } else {
        // Buffer events that arrive before listeners are registered
        // (happens during the React render cycle gap after WS connects)
        const buffered = this.eventBuffer.get(msg.event) ?? []
        if (buffered.length < WsTransport.EVENT_BUFFER_MAX_SIZE) {
          buffered.push({ msg, bufferedAt: Date.now() })
          this.eventBuffer.set(msg.event, buffered)
        }
      }
    }
  }

  private scheduleConnectRetry(): void {
    if (this.connectRetryTimer || this._hasConnectedOnce) return
    // Don't retry if there's an auth error — user needs to fix the token.
    if (this._authError) return

    // Exponential backoff while establishing the initial connection.
    const delay =
      this.connectRetryAttempt === 0
        ? 100
        : Math.min(500 * 2 ** (this.connectRetryAttempt - 1), 30_000)
    this.connectRetryAttempt++

    this.connectRetryTimer = setTimeout(() => {
      this.connectRetryTimer = null
      this.connect()
    }, delay)
  }

  private clearConnectWatchdog(): void {
    if (!this.connectWatchdog) return
    clearTimeout(this.connectWatchdog)
    this.connectWatchdog = null
  }

  private startLivenessTimer(): void {
    this.stopLivenessTimer()
    this.livenessTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this._lastInbound > WsTransport.INBOUND_TIMEOUT) {
        console.warn(
          '[WsTransport] No inbound traffic, closing stale connection for reload'
        )
        try {
          this.ws.close()
        } catch {
          // Ignore close errors; a successful close triggers the app reload.
        }
      }
    }, WsTransport.LIVENESS_CHECK_INTERVAL)
  }

  private stopLivenessTimer(): void {
    if (!this.livenessTimer) return
    clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }

  /** Re-check the connection when the page returns to the foreground or the
   *  network comes back. Fires on visibilitychange / online / pageshow. */
  private handleWake = (): void => {
    if (!this._connectEnabled) return
    // visibilitychange also fires on hide — only act when the page is visible.
    if (typeof document !== 'undefined' && document.hidden) return

    const state = this.ws?.readyState
    if (state === WebSocket.CONNECTING) return // connectWatchdog covers this

    if (state === WebSocket.OPEN) {
      // Socket claims to be open. After a suspend it may be a zombie, but a
      // recent socket may simply have queued frames. Replace one already past
      // the liveness timeout immediately so iOS resume adds no extra delay.
      if (Date.now() - this._lastInbound > WsTransport.INBOUND_TIMEOUT) {
        console.warn('[WsTransport] Stale socket after resume, reloading app')
        try {
          this.ws?.close()
        } catch {
          // Ignore close errors; a successful close triggers the app reload.
        }
      }
      return
    }

    // Before the first successful connection, retry immediately on wake.
    if (this._hasConnectedOnce) return
    if (this.connectRetryTimer) {
      clearTimeout(this.connectRetryTimer)
      this.connectRetryTimer = null
    }
    this.connectRetryAttempt = 0
    this.connect()
  }

  private restartConnectionAttempt(): void {
    this.clearConnectWatchdog()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Ignore close errors; initial connection retry will recover.
      }
      return
    }
    this.scheduleConnectRetry()
  }

  ingestBootstrapEvents(events: BootstrapEvent[]): void {
    const sorted = [...events].sort(
      (a, b) =>
        (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
    )
    for (const event of sorted) {
      this.handleMessage(event)
    }
  }
}

// Singleton instance
const wsTransport = new WsTransport()

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

/** Start browser WebSocket transport after preload/bootstrap is complete. */
export function connectTransport(): void {
  if (!usesWebSocketBackend() || isE2eMocked) return
  setWebAccessEnabled(true)
  wsTransport.enableConnect()
}

/** Run immediately when an established browser WebSocket disconnects. */
export function onEstablishedWsDisconnect(callback: () => void): () => void {
  return wsTransport.onEstablishedDisconnect(callback)
}

/**
 * Imperative connection check for non-React paths (e.g. xterm onData handler).
 * Native Tauri / E2E mock: always true (no transport drop concept).
 * Web mode: reflects current WebSocket connected state.
 */
export function isTransportConnected(): boolean {
  if (!usesWebSocketBackend() || isE2eMocked) return true
  return wsTransport.connected
}

/** Feed replayed server events through the normal event pipeline before connect. */
export function ingestBootstrapEvents(events: BootstrapEvent[]): void {
  if (events.length === 0) return
  wsTransport.ingestBootstrapEvents(events)
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
