import { useCallback, useEffect, useState } from 'react'
import { invoke, listen } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import {
  isRemotePreviewError,
  remotePreviewLoadError,
  resolveEmbeddedPreviewUrl,
  watchRemotePreviewForwards,
} from '@/lib/remote-preview'
import { isBlankTabUrl, useBrowserStore } from '@/store/browser-store'
import type {
  BrowserClosedEvent,
  BrowserGrabContext,
  BrowserGrabContextEvent,
  BrowserNavEvent,
  BrowserNewWindowEvent,
  BrowserPageLoadEvent,
  BrowserTab,
  BrowserTitleEvent,
} from '@/types/browser'

// Module-scope so both navigate() and event listeners share state.
// useBrowserEvents() mounts once at the app shell (per its JSDoc), so this is safe.
const LOAD_TIMEOUT_MS = 20_000
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>()

export const BROWSER_ENSURE_WEBVIEW_EVENT = 'jean-browser-ensure-webview'

const failureMessage = (url: string): string =>
  `Couldn't load ${url}. The site may be unreachable, the address may be wrong, or DNS lookup failed.`

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export function failBrowserLoad(tabId: string, message: string | null): void {
  clearWatchdog(tabId)
  const store = useBrowserStore.getState()
  store.setTabLoading(tabId, false)
  store.setRequestedUrl(tabId, null)
  if (message) store.setTabError(tabId, message)
}

async function commitPreview(
  tabId: string,
  url: string
): Promise<string | null> {
  try {
    const preview = await resolveEmbeddedPreviewUrl(url)
    useBrowserStore.getState().updateTab(tabId, { previewNote: preview.note })
    return preview.url
  } catch (error) {
    const message = isRemotePreviewError(error)
      ? error.message
      : failureMessage(url)
    failBrowserLoad(tabId, message)
    useBrowserStore.getState().updateTab(tabId, { previewNote: null })
    if (isRemotePreviewError(error)) {
      console.warn(`[browser] remote preview failed for ${url}:`, error.message)
    } else {
      console.error(`[browser] preview ${url} failed:`, error)
    }
    return null
  }
}

async function openWebview(tabId: string, url: string): Promise<void> {
  try {
    await invoke('browser_navigate', { tabId, url })
  } catch (error) {
    if (errorText(error).toLowerCase().includes('not found')) {
      window.dispatchEvent(
        new CustomEvent(BROWSER_ENSURE_WEBVIEW_EVENT, {
          detail: { tabId, url },
        })
      )
      return
    }
    throw error
  }
}

const timeoutMessage = (url: string): string =>
  `Loading ${url} timed out after 20s. The server may be slow or unreachable.`

function sanitizeFilenamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function grabContextFilename(context: BrowserGrabContext): string {
  const primary = sanitizeFilenamePart(
    context.componentName || context.tagName || 'element'
  )
  const secondary = sanitizeFilenamePart(
    context.text || context.selector || context.title || ''
  )
  return secondary
    ? `dom-${primary || 'element'}-${secondary}.txt`
    : `dom-${primary || 'element'}.txt`
}

function formatGrabContext(context: BrowserGrabContext): string {
  const parts = [
    'Selected DOM element from embedded browser:',
    `URL: ${context.url || 'unknown'}`,
  ]

  if (context.title) parts.push(`Title: ${context.title}`)
  if (context.componentName) parts.push(`Component: ${context.componentName}`)
  if (context.filePath) {
    const line = context.lineNumber ? `:${context.lineNumber}` : ''
    parts.push(`Source: ${context.filePath}${line}`)
  }
  parts.push(`Element: ${context.tagName || 'element'}`)
  if (context.selector) parts.push(`Selector: ${context.selector}`)
  if (context.text) parts.push(`Text: ${context.text}`)
  if (context.stackContext) {
    parts.push('', 'React stack context:', '```', context.stackContext, '```')
  }
  if (context.html) {
    parts.push('', 'HTML:', '```html', context.html, '```')
  }

  return parts.join('\n')
}

function clearWatchdog(tabId: string): void {
  const t = watchdogs.get(tabId)
  if (t) {
    clearTimeout(t)
    watchdogs.delete(tabId)
  }
}

function armWatchdog(tabId: string, requestedUrl: string): void {
  clearWatchdog(tabId)
  watchdogs.set(
    tabId,
    setTimeout(() => {
      const s = useBrowserStore.getState()
      const tab = findTab(s, tabId)
      const message =
        remotePreviewLoadError(requestedUrl, tab?.previewNote) ??
        timeoutMessage(requestedUrl)
      s.setTabLoading(tabId, false)
      s.setTabError(tabId, message)
      s.setRequestedUrl(tabId, null)
      watchdogs.delete(tabId)
    }, LOAD_TIMEOUT_MS)
  )
}

function findTab(
  state: ReturnType<typeof useBrowserStore.getState>,
  tabId: string
): BrowserTab | null {
  for (const list of Object.values(state.tabs)) {
    const t = list.find(t => t.id === tabId)
    if (t) return t
  }
  return null
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Open a Jean tab in the same worktree pane as `sourceTabId`.
 * Empty `url` is a blank tab. Returns the new tab id, or null when the
 * source tab is gone or the URL is not http(s).
 */
export function openBrowserTabFromNewWindow(
  sourceTabId: string,
  url: string
): string | null {
  const state = useBrowserStore.getState()
  const source = findTab(state, sourceTabId)
  if (!source) return null

  const target = url.trim()
  if (!target) return state.addTab(source.worktreeId)
  if (!isHttpUrl(target)) return null
  return state.addTab(source.worktreeId, target)
}

/**
 * Subscribe to all Rust → React browser events and feed them into the Zustand store.
 * Mount once at the app shell level (not per pane) — events are global.
 */
export function useBrowserEvents(): void {
  useEffect(() => {
    if (!isNativeApp()) return

    const stopPreviewWatch = watchRemotePreviewForwards()
    const unlistenPromises: Promise<() => void>[] = []

    unlistenPromises.push(
      listen<BrowserPageLoadEvent>('browser:loading', e => {
        const { tabId, url } = e.payload
        const s = useBrowserStore.getState()
        s.setTabLoading(tabId, true)
        const tab = findTab(s, tabId)
        // External nav (link click, JS redirect chain) — no requestedUrl set.
        // Update URL bar with the loading URL when there is no in-flight intent.
        // When requestedUrl is set, navigate() already wrote the URL bar; do not
        // overwrite (avoids transient about:blank flash from Started timing).
        if (!tab?.requestedUrl && !isBlankTabUrl(url)) {
          s.setTabUrl(tabId, url)
        }
        // Extend watchdog now that WebKit confirms the load actually started.
        // Cold DNS + TLS + heavy assets routinely exceed the initial budget.
        if (tab?.requestedUrl && !isBlankTabUrl(url)) {
          armWatchdog(tabId, tab.requestedUrl)
        }
      })
    )

    unlistenPromises.push(
      listen<BrowserPageLoadEvent>('browser:loaded', e => {
        const { tabId, url: loadedUrl } = e.payload
        const s = useBrowserStore.getState()
        const tab = findTab(s, tabId)
        if (!tab) return
        s.setTabLoading(tabId, false)
        clearWatchdog(tabId)

        const requestedUrl = tab.requestedUrl ?? null

        if (requestedUrl) {
          // WebKit redirected the failed nav to about:blank — the only
          // reliable explicit failure signal we get from on_page_load.
          // (Real provisional-load failures don't fire Finished at all;
          // the watchdog catches those.)
          if (isBlankTabUrl(loadedUrl)) {
            s.setTabError(
              tabId,
              remotePreviewLoadError(requestedUrl, tab.previewNote) ??
                failureMessage(requestedUrl)
            )
            s.setRequestedUrl(tabId, null)
            return
          }
          // Success — including legitimate redirects (http→https, t.co→target).
          s.setTabUrl(tabId, loadedUrl)
          s.setLastLoadedUrl(tabId, loadedUrl)
          s.setTabError(tabId, null)
          s.setRequestedUrl(tabId, null)
          return
        }

        // Passive load (link click, history nav, JS-driven, etc.).
        if (isBlankTabUrl(loadedUrl)) return
        s.setTabUrl(tabId, loadedUrl)
        s.setLastLoadedUrl(tabId, loadedUrl)
        s.setTabError(tabId, null)
      })
    )

    unlistenPromises.push(
      listen<BrowserNavEvent>('browser:nav', e => {
        const { tabId, url } = e.payload
        const tab = findTab(useBrowserStore.getState(), tabId)
        if (!tab) return
        // While a user-initiated nav is in flight, navigate() owns the URL bar.
        if (tab.requestedUrl) return
        if (isBlankTabUrl(url)) return
        useBrowserStore.getState().setTabUrl(tabId, url)
      })
    )

    unlistenPromises.push(
      listen<BrowserTitleEvent>('browser:title', e => {
        useBrowserStore.getState().setTabTitle(e.payload.tabId, e.payload.title)
      })
    )

    unlistenPromises.push(
      listen<BrowserGrabContextEvent>('browser:grab-context', e => {
        const text = formatGrabContext(e.payload.context)
        window.dispatchEvent(
          new CustomEvent('attach-pasted-text', {
            detail: {
              content: text,
              filename: grabContextFilename(e.payload.context),
            },
          })
        )
      })
    )

    unlistenPromises.push(
      listen<BrowserNewWindowEvent>('browser:new-window', e => {
        openBrowserTabFromNewWindow(e.payload.tabId, e.payload.url)
      })
    )

    unlistenPromises.push(
      listen<BrowserClosedEvent>('browser:closed', e => {
        // Backend confirms the child webview closed. The store usually already
        // removed the tab; this catches a close that did not go through removeTab.
        const state = useBrowserStore.getState()
        for (const [wid, list] of Object.entries(state.tabs)) {
          if (list.some(t => t.id === e.payload.tabId)) {
            state.removeTab(wid, e.payload.tabId)
            break
          }
        }
        clearWatchdog(e.payload.tabId)
      })
    )

    return () => {
      stopPreviewWatch()
      for (const t of watchdogs.values()) clearTimeout(t)
      watchdogs.clear()
      for (const p of unlistenPromises) {
        p.then(fn => fn()).catch(err => {
          console.warn('[browser] unlisten failed:', err)
        })
      }
    }
  }, [])
}

/**
 * Detect any open Radix Dialog / AlertDialog / DropdownMenu / Select via DOM.
 * Used to suppress the native child webview (which paints over DOM) so
 * modals appear on top instead of behind the embedded browser page.
 *
 * Reactive via MutationObserver on body subtree watching `data-state` attr.
 */
// Exclude browser/terminal own Sheet hosts — Radix Dialog wraps their content
// with role="dialog", but those panes ARE the browser surface (or its sibling),
// not blocking modals. Without exclusion, opening the browser as a floating
// Sheet would suppress its own webview, and opening the terminal Sheet would
// hide the browser webview behind it.
const BLOCKING_SELECTOR =
  '[role="dialog"][data-state="open"]:not([data-browser-host]):not([data-terminal-host]), [role="alertdialog"][data-state="open"]'

export function useAnyBlockingModalOpen(): boolean {
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    const compute = () => setIsOpen(!!document.querySelector(BLOCKING_SELECTOR))
    compute()
    const observer = new MutationObserver(compute)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'role'],
    })
    return () => observer.disconnect()
  }, [])
  return isOpen
}

interface BrowserActions {
  navigate: (url: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  stop: () => Promise<void>
  close: () => Promise<void>
  focus: () => Promise<void>
  enableGrab: () => Promise<void>
}

/** Hook returning stable action callbacks for a single browser tab. */
export function useBrowserTabActions(tabId: string | null): BrowserActions {
  const navigate = useCallback(
    async (url: string) => {
      if (!tabId || !isNativeApp()) return
      const s = useBrowserStore.getState()
      // Optimistic UI: URL bar shows what the user asked for while the
      // remote preview forward is negotiated.
      s.setTabUrl(tabId, url)
      s.setTabError(tabId, null)
      s.setTabLoading(tabId, true)
      const prepared = await commitPreview(tabId, url)
      if (!prepared) return
      s.setTabUrl(tabId, prepared)
      s.setRequestedUrl(tabId, prepared)
      armWatchdog(tabId, prepared)
      try {
        await openWebview(tabId, prepared)
      } catch (err) {
        const note = findTab(useBrowserStore.getState(), tabId)?.previewNote
        failBrowserLoad(
          tabId,
          remotePreviewLoadError(prepared, note) ?? failureMessage(prepared)
        )
        console.error(`[browser] navigate(${prepared}) failed:`, err)
      }
    },
    [tabId]
  )

  const back = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    try {
      await invoke('browser_back', { tabId })
    } catch (err) {
      console.error('[browser] back failed:', err)
    }
  }, [tabId])

  const forward = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    try {
      await invoke('browser_forward', { tabId })
    } catch (err) {
      console.error('[browser] forward failed:', err)
    }
  }, [tabId])

  const reload = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    const s = useBrowserStore.getState()
    const tab = findTab(s, tabId)
    const currentUrl = tab?.url ?? ''
    if (isBlankTabUrl(currentUrl)) {
      try {
        await invoke('browser_reload', { tabId })
      } catch (err) {
        console.error('[browser] reload failed:', err)
      }
      return
    }
    s.setTabError(tabId, null)
    s.setTabLoading(tabId, true)
    const prepared = await commitPreview(tabId, currentUrl)
    if (!prepared) return
    s.setRequestedUrl(tabId, prepared)
    armWatchdog(tabId, prepared)
    try {
      if (prepared !== currentUrl) {
        s.setTabUrl(tabId, prepared)
        await openWebview(tabId, prepared)
      } else {
        await invoke('browser_reload', { tabId })
      }
    } catch (err) {
      const note = findTab(useBrowserStore.getState(), tabId)?.previewNote
      failBrowserLoad(
        tabId,
        remotePreviewLoadError(prepared, note) ?? failureMessage(prepared)
      )
      console.error('[browser] reload failed:', err)
    }
  }, [tabId])

  const stop = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    clearWatchdog(tabId)
    try {
      await invoke('browser_stop', { tabId })
      // Also flip loading state immediately — webkit may not fire `loaded`
      // for an aborted navigation, leaving the spinner forever.
      const s = useBrowserStore.getState()
      s.setTabLoading(tabId, false)
      s.setRequestedUrl(tabId, null)
    } catch (err) {
      console.error('[browser] stop failed:', err)
    }
  }, [tabId])

  const close = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    clearWatchdog(tabId)
    try {
      await invoke('browser_close', { tabId })
    } catch (err) {
      console.error('[browser] close failed:', err)
    }
  }, [tabId])

  const enableGrab = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    try {
      const theme = document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light'
      await invoke('browser_enable_grab', { tabId, theme })
    } catch (err) {
      console.error('[browser] enable grab failed:', err)
      throw err
    }
  }, [tabId])

  const focus = useCallback(async () => {
    if (!tabId || !isNativeApp()) return
    try {
      await invoke('browser_set_focus', { tabId })
    } catch (err) {
      console.error('[browser] focus failed:', err)
    }
  }, [tabId])

  return { navigate, back, forward, reload, stop, close, focus, enableGrab }
}

/** Helpers to call backend lifecycle commands without going through React. */
export const browserBackend = {
  async create(
    tabId: string,
    url: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<boolean> {
    if (!isNativeApp()) return false
    const prepared = await commitPreview(tabId, url)
    if (!prepared) return false
    const store = useBrowserStore.getState()
    store.setTabUrl(tabId, prepared)
    store.setRequestedUrl(tabId, prepared)
    store.setTabLoading(tabId, true)
    armWatchdog(tabId, prepared)
    try {
      await invoke<string>('browser_create', {
        tabId,
        url: prepared,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      })
      return true
    } catch (error) {
      const note = findTab(useBrowserStore.getState(), tabId)?.previewNote
      failBrowserLoad(
        tabId,
        remotePreviewLoadError(prepared, note) ?? failureMessage(prepared)
      )
      console.error(`[browser] create(${prepared}) failed:`, error)
      return false
    }
  },
  async setBounds(
    tabId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<void> {
    if (!isNativeApp()) return
    await invoke('browser_set_bounds', {
      tabId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    })
  },
  async setVisible(tabId: string, visible: boolean): Promise<void> {
    if (!isNativeApp()) return
    await invoke('browser_set_visible', { tabId, visible })
  },
  async hasActive(tabId: string): Promise<boolean> {
    if (!isNativeApp()) return false
    try {
      return await invoke<boolean>('has_active_browser_tab', { tabId })
    } catch {
      return false
    }
  },
  async close(tabId: string): Promise<void> {
    if (!isNativeApp()) return
    try {
      await invoke('browser_close', { tabId })
    } catch {
      // ignore — tab may already be gone
    }
  },
}
