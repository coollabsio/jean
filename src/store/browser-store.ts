import { create } from 'zustand'
import { generateId } from '@/lib/uuid'
import type { BrowserTab } from '@/types/browser'
import { useTerminalStore } from './terminal-store'
import { isRightPanelShowing, syncRightPanelSurface } from '@/lib/right-panel'

// Opaque data: URL instead of about:blank — WKWebView renders about:blank
// as a transparent surface, so a previous tab's pixels can bleed through when
// switching tabs. The page takes the app's --background so a blank tab matches
// the chat in both themes. Encoded so WebKit does not read `#` as a fragment.
export function blankTabUrl(): string {
  const background =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement)
          .getPropertyValue('--background')
          .trim()
  const html = `<!DOCTYPE html><html><head><title>New Tab</title></head><body style="margin:0;background:${background || '#fff'}"></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// Treat any data: URL as blank — WebKit normalizes the placeholder URL
// (drops ;charset=utf-8, percent-encodes, splits the literal `#` as a fragment)
// and Tauri injects a CSP <meta>, so equality with blankTabUrl() fails.
// Users cannot navigate to data: URLs in this app (normalizeUrl rejects them).
export const isBlankTabUrl = (u: string): boolean =>
  !u || u === 'about:blank' || u.startsWith('data:')

interface BrowserState {
  // Per-worktree tab list
  tabs: Record<string, BrowserTab[]>
  // Active tab id per worktree
  activeTabIds: Record<string, string>

  // Browser tab open in the right panel, per worktree
  modalOpen: Record<string, boolean>

  // Selectors
  getTabs: (worktreeId: string) => BrowserTab[]
  getActiveTab: (worktreeId: string) => BrowserTab | null
  isModalOpen: (worktreeId: string) => boolean

  // Tab actions
  addTab: (worktreeId: string, url?: string) => string
  removeTab: (worktreeId: string, tabId: string) => void
  clearWorktreeState: (worktreeId: string) => string[]
  setActiveTab: (worktreeId: string, tabId: string) => void
  updateTab: (tabId: string, patch: Partial<Omit<BrowserTab, 'id'>>) => void
  setTabUrl: (tabId: string, url: string) => void
  setTabTitle: (tabId: string, title: string) => void
  setTabLoading: (tabId: string, loading: boolean) => void
  setTabError: (tabId: string, error: string | null) => void
  setRequestedUrl: (tabId: string, url: string | null) => void
  setLastLoadedUrl: (tabId: string, url: string | null) => void
  // Hydration (used by useUIStatePersistence on app load)
  hydrateTabs: (
    tabs: Record<string, BrowserTab[]>,
    activeTabIds: Record<string, string>
  ) => void

  // Right panel browser tab actions
  setModalOpen: (worktreeId: string, open: boolean) => void
  toggleModal: (worktreeId: string) => void
}

function findWorktreeForTab(
  tabs: Record<string, BrowserTab[]>,
  tabId: string
): string | null {
  for (const [wid, list] of Object.entries(tabs)) {
    if (list.some(t => t.id === tabId)) return wid
  }
  return null
}

/** Close the terminal modal for this worktree — browser and terminal modal
 * surfaces are mutually exclusive. Called inside browser-store actions when
 * opening the browser modal. */
function closeTerminalModalFor(worktreeId: string): void {
  const terminal = useTerminalStore.getState()
  if (!(terminal.modalTerminalOpen[worktreeId] ?? false)) return
  useTerminalStore.setState({
    modalTerminalOpen: {
      ...terminal.modalTerminalOpen,
      [worktreeId]: false,
    },
  })
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: {},
  activeTabIds: {},
  modalOpen: {},

  getTabs: worktreeId => get().tabs[worktreeId] ?? [],

  getActiveTab: worktreeId => {
    const tabs = get().tabs[worktreeId] ?? []
    const activeId = get().activeTabIds[worktreeId]
    return tabs.find(t => t.id === activeId) ?? null
  },

  isModalOpen: worktreeId => get().modalOpen[worktreeId] ?? false,

  addTab: (worktreeId, url = blankTabUrl()) => {
    const id = generateId()
    // about:blank loads instantly with no `browser:loaded` event — skip
    // the spinner state entirely so the tab pill doesn't stay loading.
    const tab: BrowserTab = {
      id,
      worktreeId,
      url,
      title: '',
      isLoading: !isBlankTabUrl(url),
      error: null,
    }
    set(state => ({
      tabs: {
        ...state.tabs,
        [worktreeId]: [...(state.tabs[worktreeId] ?? []), tab],
      },
      activeTabIds: { ...state.activeTabIds, [worktreeId]: id },
    }))
    return id
  },

  removeTab: (worktreeId, tabId) =>
    set(state => {
      const existing = state.tabs[worktreeId] ?? []
      if (!existing.some(t => t.id === tabId)) return state
      const filtered = existing.filter(t => t.id !== tabId)
      const currentActive = state.activeTabIds[worktreeId] ?? ''
      const newActive =
        currentActive === tabId
          ? (filtered[filtered.length - 1]?.id ?? '')
          : currentActive
      // Closing the last tab also closes the browser for this worktree —
      // mirrors how closing the last terminal tab dismisses the terminal.
      const closedAll = filtered.length === 0
      return {
        tabs: { ...state.tabs, [worktreeId]: filtered },
        activeTabIds: { ...state.activeTabIds, [worktreeId]: newActive },
        modalOpen: closedAll
          ? { ...state.modalOpen, [worktreeId]: false }
          : state.modalOpen,
      }
    }),

  clearWorktreeState: worktreeId => {
    const state = get()
    const tabIds = (state.tabs[worktreeId] ?? []).map(tab => tab.id)
    const hasWorktreeState =
      tabIds.length > 0 ||
      worktreeId in state.tabs ||
      worktreeId in state.activeTabIds ||
      worktreeId in state.modalOpen
    if (!hasWorktreeState) return []

    set(current => {
      const { [worktreeId]: _tabs, ...tabs } = current.tabs
      const { [worktreeId]: _activeTab, ...activeTabIds } = current.activeTabIds
      const { [worktreeId]: _modal, ...modalOpen } = current.modalOpen
      return { tabs, activeTabIds, modalOpen }
    })

    return tabIds
  },

  setActiveTab: (worktreeId, tabId) =>
    set(state => {
      if (state.activeTabIds[worktreeId] === tabId) return state
      return {
        activeTabIds: { ...state.activeTabIds, [worktreeId]: tabId },
      }
    }),

  updateTab: (tabId, patch) =>
    set(state => {
      const wid = findWorktreeForTab(state.tabs, tabId)
      if (!wid) return state
      const list = state.tabs[wid] ?? []
      const idx = list.findIndex(t => t.id === tabId)
      if (idx === -1) return state
      const existing = list[idx]
      if (!existing) return state
      // No-op guard: skip update if every patched field is unchanged
      let changed = false
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
        if (existing[k] !== patch[k]) {
          changed = true
          break
        }
      }
      if (!changed) return state
      const next = [...list]
      next[idx] = { ...existing, ...patch }
      return { tabs: { ...state.tabs, [wid]: next } }
    }),

  setTabUrl: (tabId, url) => get().updateTab(tabId, { url }),
  setTabTitle: (tabId, title) => get().updateTab(tabId, { title }),
  setTabLoading: (tabId, loading) =>
    get().updateTab(tabId, { isLoading: loading }),
  setTabError: (tabId, error) => get().updateTab(tabId, { error }),
  setRequestedUrl: (tabId, url) =>
    get().updateTab(tabId, { requestedUrl: url }),
  setLastLoadedUrl: (tabId, url) =>
    get().updateTab(tabId, { lastLoadedUrl: url }),

  hydrateTabs: (tabs, activeTabIds) => set({ tabs, activeTabIds }),

  setModalOpen: (worktreeId, open) => {
    syncRightPanelSurface(worktreeId, 'browser', open)
    const current = useBrowserStore.getState().modalOpen[worktreeId] ?? false
    if (current === open) return
    if (open) closeTerminalModalFor(worktreeId)
    set(state => ({
      modalOpen: { ...state.modalOpen, [worktreeId]: open },
    }))
  },

  toggleModal: worktreeId => {
    useBrowserStore
      .getState()
      .setModalOpen(worktreeId, !isRightPanelShowing('browser'))
  },
}))
