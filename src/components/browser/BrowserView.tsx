import { memo, useEffect } from 'react'
import { AlertTriangle, RotateCw } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { useBrowserStore } from '@/store/browser-store'
import {
  useAnyBlockingModalOpen,
  useBrowserTabActions,
} from '@/hooks/useBrowserPane'
import { useChatStore } from '@/store/chat-store'
import { usePorts } from '@/services/projects'
import { resolveDefaultTabUrl } from './default-tab-url'
import { BrowserTabContent } from './BrowserTabContent'
import { BrowserToolbar } from './BrowserToolbar'
import type { BrowserTab } from '@/types/browser'

// Stable empty-array reference for the no-tabs case. A fresh `[]` literal each
// invocation breaks `useSyncExternalStore`'s Object.is check and triggers
// forceStoreRerender on every store update — the classic Zustand selector
// fallback loop ("Maximum update depth exceeded").
const EMPTY_TABS: BrowserTab[] = []

interface BrowserViewProps {
  worktreeId: string
  isVisible: boolean
  onClose?: () => void
  /** Forwarded to BrowserTabContent — bumps to retrigger bounds detection
   * when the host surface's layout changes (dock side, modal mode). */
  relayoutNonce?: string | number
}

/**
 * Per-worktree browser view: toolbar (tabs + URL bar) + the active tab body.
 * Renders ALL tabs (so each gets a stable placeholder), but only the active
 * tab's webview is shown. When `isVisible` flips to false, every tab is hidden.
 */
export const BrowserView = memo(function BrowserView({
  worktreeId,
  isVisible,
  onClose,
  relayoutNonce,
}: BrowserViewProps) {
  const tabs = useBrowserStore(state => state.tabs[worktreeId] ?? EMPTY_TABS)
  const activeTabId = useBrowserStore(
    state => state.activeTabIds[worktreeId] ?? ''
  )
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null
  const blockingModalOpen = useAnyBlockingModalOpen()
  const activeError = activeTab?.error ?? null
  // Native child webview paints over DOM. Suppress it whenever:
  //   - Any blocking modal is open (so modal renders above)
  //   - Active tab has a load error (so the error overlay shows instead)
  const effectiveVisible = isVisible && !blockingModalOpen && !activeError
  const actions = useBrowserTabActions(activeTabId || null)

  // Resolve worktreePath → first jean.json port (used as default new-tab URL)
  const worktreePath = useChatStore(state => state.worktreePaths[worktreeId])
  const { data: ports, isFetched: portsFetched } = usePorts(
    worktreePath ?? null
  )

  // Auto-create the first tab when the view first opens with no tabs.
  // Wait for ports query so we can default to localhost:<port> if configured.
  useEffect(() => {
    if (!isVisible || tabs.length > 0) return
    if (!worktreePath) {
      useBrowserStore.getState().addTab(worktreeId)
      return
    }
    if (!portsFetched) return
    useBrowserStore.getState().addTab(worktreeId, resolveDefaultTabUrl(ports))
  }, [isVisible, tabs.length, worktreeId, worktreePath, portsFetched, ports])

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <BrowserToolbar worktreeId={worktreeId} onClose={onClose} />
      <div className="relative flex-1 overflow-hidden">
        {activeError && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <AlertTriangle className="h-8 w-8 text-warning" />
            <div className="text-sm font-medium">Could not load page</div>
            <div className="max-w-md text-xs text-muted-foreground">
              {activeError}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                useBrowserStore.getState().setTabError(activeTabId, null)
                void actions.reload()
              }}
            >
              <RotateCw className="mr-1.5 h-3 w-3" />
              Retry
            </Button>
          </div>
        )}
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{
              visibility:
                isVisible && tab.id === activeTabId ? 'visible' : 'hidden',
              zIndex: tab.id === activeTabId ? 1 : 0,
            }}
          >
            <BrowserTabContent
              tabId={tab.id}
              isActive={effectiveVisible && tab.id === activeTabId}
              relayoutNonce={relayoutNonce}
            />
          </div>
        ))}
      </div>
    </div>
  )
})
