import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Loader2,
  MousePointer2,
  Plus,
  RotateCw,
  X,
  XSquare,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isBlankTabUrl, useBrowserStore } from '@/store/browser-store'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { browserBackend, useBrowserTabActions } from '@/hooks/useBrowserPane'
import {
  usePorts,
  useTerminalListeningPorts,
  type TerminalPortInfo,
} from '@/services/projects'
import {
  listBrowserPortChoices,
  resolveNewTabUrl,
  resolvePortOpenAction,
  type BrowserPortChoice,
} from './default-tab-url'
import type { BrowserTab } from '@/types/browser'
import { toast } from 'sonner'

// Stable empty-array reference — see comment in BrowserView.tsx.
const EMPTY_TABS: BrowserTab[] = []
const EMPTY_LISTENING: TerminalPortInfo[] = []

const displayUrl = (u: string): string => (isBlankTabUrl(u) ? '' : u)

interface BrowserToolbarProps {
  worktreeId: string
  className?: string
  /** Render close (X) button to dismiss the entire pane */
  onClose?: () => void
  /** Server preview hostname. Same value the first tab uses. */
  serverDefaultHost?: string | null
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed
  // Loopback hosts → http:// (local dev servers usually lack TLS).
  if (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)
  )
    return `http://${trimmed}`
  // If it has a dot and no spaces, treat as URL; else as Google search.
  if (/^[^\s]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

const PortMenuItem = memo(function PortMenuItem({
  choice,
  onOpenPort,
}: {
  choice: BrowserPortChoice
  onOpenPort: (url: string) => void
}) {
  const handleSelect = useCallback(() => {
    onOpenPort(choice.url)
  }, [choice.url, onOpenPort])

  return (
    <DropdownMenuItem onSelect={handleSelect} title={choice.url}>
      <span className="truncate">{choice.label}</span>
    </DropdownMenuItem>
  )
})

const BrowserPortControl = memo(function BrowserPortControl({
  choices,
  onOpenPort,
}: {
  choices: BrowserPortChoice[]
  onOpenPort: (url: string) => void
}) {
  const only = choices.length === 1 ? choices[0] : undefined
  const handleOpenOnly = useCallback(() => {
    if (only) onOpenPort(only.url)
  }, [onOpenPort, only])

  if (choices.length === 0) return null

  if (only) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={handleOpenOnly}
        aria-label={`Open ${only.label}`}
        title={only.url}
      >
        <Globe className="h-3.5 w-3.5" />
      </Button>
    )
  }

  const configured = choices.filter(choice => choice.source === 'configured')
  const listening = choices.filter(choice => choice.source === 'listening')
  const showGroups = configured.length > 0 && listening.length > 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label="Choose port"
          title="Choose port"
        >
          <Globe className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        data-browser-port-menu=""
        className="max-w-80 min-w-56"
      >
        {showGroups && (
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Configured
          </DropdownMenuLabel>
        )}
        {configured.map(choice => (
          <PortMenuItem
            key={choice.id}
            choice={choice}
            onOpenPort={onOpenPort}
          />
        ))}
        {showGroups && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Listening
            </DropdownMenuLabel>
          </>
        )}
        {listening.map(choice => (
          <PortMenuItem
            key={choice.id}
            choice={choice}
            onOpenPort={onOpenPort}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

const TabPill = memo(function TabPill({
  tab,
  isActive,
  onSelect,
  onClose,
}: {
  tab: BrowserTab
  isActive: boolean
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
}) {
  const handleClick = useCallback(() => {
    onSelect(tab.id)
  }, [onSelect, tab.id])
  const handleClose = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation()
      onClose(tab.id)
    },
    [onClose, tab.id]
  )

  let host = ''
  try {
    host = new URL(tab.url).host
  } catch {
    host = tab.url
  }
  const label = tab.title || host || 'New Tab'
  return (
    <div
      className={cn(
        'group flex h-7 max-w-[160px] cursor-default items-center gap-1.5 rounded-md border px-2 text-xs',
        isActive
          ? 'border-border bg-background text-foreground'
          : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted'
      )}
      title={tab.title || tab.url}
    >
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
        onClick={handleClick}
        title={tab.title || tab.url}
      >
        {tab.isLoading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
        )}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-muted-foreground/20 hover:opacity-100"
        onClick={handleClose}
        aria-label="Close tab"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
})

export const BrowserToolbar = memo(function BrowserToolbar({
  worktreeId,
  className,
  onClose,
  serverDefaultHost,
}: BrowserToolbarProps) {
  const tabs = useBrowserStore(state => state.tabs[worktreeId] ?? EMPTY_TABS)
  const activeTabId = useBrowserStore(
    state => state.activeTabIds[worktreeId] ?? ''
  )
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null

  const activeUrl = activeTab?.url ?? ''
  const [draftUrl, setDraftUrl] = useState(() => displayUrl(activeUrl))
  const [editing, setEditing] = useState(false)
  // Track last synced (url, editing) so external navigations and blur refresh the
  // draft without an effect. Hide synthetic DEFAULT_NEW_TAB_URL data: URLs.
  const [synced, setSynced] = useState({ url: activeUrl, editing: false })
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Adjust state during render (React-recommended) instead of effect-as-handler.
  if (activeUrl !== synced.url || editing !== synced.editing) {
    setSynced({ url: activeUrl, editing })
    if (!editing) {
      setDraftUrl(displayUrl(activeUrl))
    }
  }

  // Auto-focus URL input when switching to (or opening) a blank tab so users
  // can start typing immediately.
  useEffect(() => {
    if (!activeTabId) return
    if (isBlankTabUrl(activeTab?.url ?? '')) {
      inputRef.current?.focus()
    }
    // intentionally only on tab switch — not on url updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId])

  const actions = useBrowserTabActions(activeTabId || null)
  const worktreePath = useChatStore(
    state => state.worktreePaths[worktreeId] ?? null
  )
  const { data: configuredPorts } = usePorts(worktreePath)
  const terminals = useTerminalStore(state => state.terminals[worktreeId])
  const { data: listeningPorts = EMPTY_LISTENING } = useTerminalListeningPorts(
    (terminals?.length ?? 0) > 0
  )
  const portChoices = useMemo(() => {
    const ids = new Set((terminals ?? []).map(terminal => terminal.id))
    const mine =
      ids.size === 0
        ? []
        : listeningPorts.filter(port => ids.has(port.terminalId))
    return listBrowserPortChoices(configuredPorts, mine, serverDefaultHost)
  }, [configuredPorts, listeningPorts, serverDefaultHost, terminals])

  const navigate = actions.navigate

  const openPort = useCallback(
    (url: string) => {
      const state = useBrowserStore.getState()
      const openTabs = state.tabs[worktreeId] ?? EMPTY_TABS
      const currentId = state.activeTabIds[worktreeId] ?? ''
      const action = resolvePortOpenAction(url, openTabs, currentId || null)
      switch (action.type) {
        case 'focus':
          state.setActiveTab(worktreeId, action.tabId)
          return
        case 'navigate':
          void navigate(url)
          return
        case 'add-tab':
          state.addTab(worktreeId, url)
          return
        case 'noop':
          return
      }
    },
    [navigate, worktreeId]
  )

  const handleAddTab = useCallback(() => {
    const state = useBrowserStore.getState()
    const openTabs = state.tabs[worktreeId] ?? EMPTY_TABS
    const current = openTabs.find(
      tab => tab.id === (state.activeTabIds[worktreeId] ?? '')
    )
    const url = resolveNewTabUrl(
      configuredPorts,
      openTabs.map(tab => tab.url),
      serverDefaultHost
    )
    // A blank extra tab is reused for the next configured port. One port
    // still adds a blank tab in a single click.
    if (url && current && isBlankTabUrl(current.url)) {
      void navigate(url)
      return
    }
    state.addTab(worktreeId, url)
  }, [configuredPorts, navigate, serverDefaultHost, worktreeId])

  const handleSelectTab = useCallback(
    (tabId: string) => {
      useBrowserStore.getState().setActiveTab(worktreeId, tabId)
    },
    [worktreeId]
  )

  const handleCloseTab = useCallback(
    (tabId: string) => {
      useBrowserStore.getState().removeTab(worktreeId, tabId)
      void browserBackend.close(tabId)
    },
    [worktreeId]
  )

  const handleEnableGrab = useCallback(() => {
    void actions
      .enableGrab()
      .then(() => toast.success('Grab enabled for this browser tab'))
      .catch(error => toast.error(`Failed to enable Grab: ${error}`))
  }, [actions])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const target = normalizeUrl(draftUrl)
      if (!target) return
      void actions.navigate(target)
      setEditing(false)
    },
    [actions, draftUrl]
  )

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-b bg-card px-2 pt-1.5 pb-1.5',
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => void actions.back()}
          disabled={!activeTab}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => void actions.forward()}
          disabled={!activeTab}
          aria-label="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        {activeTab?.isLoading ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void actions.stop()}
            aria-label="Stop loading"
          >
            <XSquare className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void actions.reload()}
            disabled={!activeTab}
            aria-label="Reload"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleEnableGrab}
              disabled={!activeTab || isBlankTabUrl(activeTab.url)}
              aria-label="Grab DOM element"
            >
              <MousePointer2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Grab DOM element</TooltipContent>
        </Tooltip>
        <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
          <Input
            ref={inputRef}
            value={draftUrl}
            onChange={e => {
              setEditing(true)
              setDraftUrl(e.target.value)
            }}
            onFocus={e => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            placeholder="Search or enter URL"
            className="h-7 px-2 text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!activeTab}
          />
        </form>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            aria-label="Close browser"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {activeTab?.previewNote && (
        <p
          className="px-1 text-xs leading-snug text-muted-foreground"
          role="status"
        >
          {activeTab.previewNote}
        </p>
      )}
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map(tab => (
            <TabPill
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={handleSelectTab}
              onClose={handleCloseTab}
            />
          ))}
        </div>
        <BrowserPortControl choices={portChoices} onOpenPort={openPort} />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={handleAddTab}
          aria-label="New tab"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
})
