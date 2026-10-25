/**
 * Types for the embedded browser pane (per-worktree multi-tab native webview).
 * Mirror Rust event payload shapes from src-tauri/src/browser/types.rs
 */

export type ModalBrowserDockMode = 'floating' | 'left' | 'right' | 'bottom'

export interface BrowserTab {
  id: string
  worktreeId: string
  url: string
  title: string
  isLoading: boolean
  /** Set when load fails / times out. Cleared on next successful navigation. */
  error?: string | null
  /** What the user asked to load. Set in navigate(); cleared on browser:loaded resolution. */
  requestedUrl?: string | null
  /** Last URL that successfully reached browser:loaded. Used to detect WKWebView fallback-to-previous on failed nav. */
  lastLoadedUrl?: string | null
  /** Explains a remote-host preview rewrite. Cleared for ordinary URLs. */
  previewNote?: string | null
}

// Rust → React event payloads (camelCase via serde rename_all)
export interface BrowserPageLoadEvent {
  tabId: string
  url: string
}

export interface BrowserNavEvent {
  tabId: string
  url: string
}

export interface BrowserTitleEvent {
  tabId: string
  title: string
}

export interface BrowserClosedEvent {
  tabId: string
}

/** `window.open` / `target=_blank` from a child webview. Empty `url` is a blank tab. */
export interface BrowserNewWindowEvent {
  tabId: string
  url: string
}

export interface BrowserGrabContext {
  url: string
  title: string
  tagName: string
  componentName?: string | null
  filePath?: string | null
  lineNumber?: number | null
  selector?: string | null
  text?: string | null
  html?: string | null
  stackContext?: string | null
}

export interface BrowserGrabContextEvent {
  tabId: string
  context: BrowserGrabContext
}

/**
 * Bounds passed to `browser_create` / `browser_set_bounds`, in physical pixels
 * (CSS pixels × `devicePixelRatio`). `BrowserTabContent` measures the
 * placeholder that way, and Rust applies `PhysicalPosition` / `PhysicalSize`
 * without a second `scale_factor()` conversion.
 */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}
