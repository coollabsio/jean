import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Settings,
  Palette,
  Keyboard,
  Wand2,
  Plug,
  BarChart3,
  Puzzle,
  Globe,
  GitBranch,
  Rabbit,
  Sparkles,
  Terminal,
  Server,
  Cpu,
  type LucideIcon,
} from '@/components/icons/reicon'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { useUIStore, type PreferencePane } from '@/store/ui-store'
import type { KeybindingAction } from '@/types/keybindings'
import { ClaudeIcon } from '@/components/icons/ClaudeIcon'
import { CodexIcon } from '@/components/icons/CodexIcon'
import { OpenCodeIcon } from '@/components/icons/OpenCodeIcon'
import { CursorIcon } from '@/components/icons/CursorIcon'
import { PiIcon } from '@/components/icons/PiIcon'
import { CommandCodeIcon } from '@/components/icons/CommandCodeIcon'
import { GrokIcon } from '@/components/icons/GrokIcon'
import { KimiIcon } from '@/components/icons/KimiIcon'
import { DevinIcon } from '@/components/icons/DevinIcon'
import { AntigravityIcon } from '@/components/icons/AntigravityIcon'
import { MuseIcon } from '@/components/icons/MuseIcon'
import type { MagicPrompts } from '@/types/preferences'
import { GeneralPane } from './panes/GeneralPane'
import {
  BackendsPane,
  isBackendPane,
  type BackendPane,
} from './panes/BackendsPane'
import { AppearancePane } from './panes/AppearancePane'
import { KeybindingsPane } from './panes/KeybindingsPane'
import { TerminalPane } from './panes/TerminalPane'
import { MagicPromptsPane } from './panes/MagicPromptsPane'
import { McpServersPane } from './panes/McpServersPane'
import { UsagePane } from './panes/UsagePane'
import { IntegrationsPane } from './panes/IntegrationsPane'
import { WebAccessPane } from './panes/WebAccessPane'
import { OpinionatedPane } from './panes/OpinionatedPane'
import {
  searchPreferenceEntries,
  type PreferenceSearchEntry,
} from './preferences-search'
import { PreferencesSearchBar } from './PreferencesSearchBar'
import { isNativeApp } from '@/lib/environment'
import { useRemoteConnections } from '@/lib/remote-connections'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { SettingsTargetProvider } from '@/lib/settings-target'

const SETTINGS_TARGET_KEY = 'jean-settings-target-server'

type NavigationId = Exclude<PreferencePane, BackendPane> | 'backends'

interface NavigationItem {
  id: NavigationId
  name: string
  icon: LucideIcon
  desktopOnly?: boolean
}

const navigationItems: NavigationItem[] = [
  { id: 'general', name: 'General', icon: Settings },
  { id: 'appearance', name: 'Appearance', icon: Palette },
  { id: 'keybindings', name: 'Keybindings', icon: Keyboard, desktopOnly: true },
  { id: 'backends', name: 'Backends', icon: Cpu },
  { id: 'terminal', name: 'Terminal', icon: Terminal },
  { id: 'magic-prompts', name: 'Magic Prompts', icon: Wand2 },
  { id: 'opinionated', name: 'Opinionated', icon: Sparkles },
  { id: 'mcp-servers', name: 'MCP Servers', icon: Plug },
  { id: 'integrations', name: 'Integrations', icon: Puzzle },
  { id: 'web-access', name: 'Web Access', icon: Globe },
  { id: 'usage', name: 'Usage', icon: BarChart3 },
]

const mobileNavigationItems = navigationItems.filter(item => !item.desktopOnly)

function navigationIdForPane(pane: PreferencePane): NavigationId {
  return isBackendPane(pane) ? 'backends' : pane
}

function navigationName(pane: PreferencePane): string {
  const id = navigationIdForPane(pane)
  return navigationItems.find(item => item.id === id)?.name ?? 'General'
}

const paneIconMap: Record<PreferencePane, LucideIcon> = {
  general: Settings,
  claude: ClaudeIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  pi: PiIcon,
  commandcode: CommandCodeIcon,
  grok: GrokIcon,
  kimi: KimiIcon,
  devin: DevinIcon,
  antigravity: AntigravityIcon,
  muse: MuseIcon,
  github: GitBranch,
  coderabbit: Rabbit,
  opinionated: Sparkles,
  usage: BarChart3,
  appearance: Palette,
  keybindings: Keyboard,
  terminal: Terminal,
  'magic-prompts': Wand2,
  'mcp-servers': Plug,
  integrations: Puzzle,
  'web-access': Globe,
}

/** Group search results by pane, preserving Fuse.js ranking order within each group. */
function groupResultsByPane(results: PreferenceSearchEntry[]) {
  const groups: {
    pane: PreferencePane
    title: string
    items: PreferenceSearchEntry[]
  }[] = []
  const seen = new Set<PreferencePane>()

  for (const result of results) {
    if (!seen.has(result.pane)) {
      seen.add(result.pane)
      groups.push({ pane: result.pane, title: result.paneTitle, items: [] })
    }
    const group = groups.find(g => g.pane === result.pane)
    if (group) group.items.push(result)
  }

  return groups
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  ) {
    return true
  }

  return !!target.closest(
    '.cm-editor, .cm-content, .monaco-editor, [contenteditable="true"], [role="textbox"]'
  )
}

export function PreferencesDialog() {
  const [activePane, setActivePane] = useState<PreferencePane>('general')
  const [searchValue, setSearchValue] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchSelection, setSearchSelection] = useState('')
  const pendingJumpRef = useRef<PreferenceSearchEntry | null>(null)
  const [pendingJumpTick, setPendingJumpTick] = useState(0)
  const [searchTargetAction, setSearchTargetAction] =
    useState<KeybindingAction | null>(null)
  const [searchTargetPromptKey, setSearchTargetPromptKey] = useState<
    keyof MagicPrompts | null
  >(null)
  const preferencesOpen = useUIStore(state => state.preferencesOpen)
  const setPreferencesOpen = useUIStore(state => state.setPreferencesOpen)
  const preferencesPane = useUIStore(state => state.preferencesPane)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchContainerRef = useRef<HTMLDivElement>(null)
  const mobileSearchContainerRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const remoteConnections = useRemoteConnections()
  const serverSnapshots = useServerConnectionSnapshots()
  const showServerTarget = isNativeApp() && remoteConnections.length > 0
  const [settingsServerId, setSettingsServerId] = useState(() => {
    if (!isNativeApp() || typeof window === 'undefined') return LOCAL_SERVER_ID
    const saved = window.localStorage.getItem(SETTINGS_TARGET_KEY)
    return saved &&
      remoteConnections.some(connection => connection.id === saved)
      ? saved
      : LOCAL_SERVER_ID
  })

  const handleSettingsServerChange = useCallback((serverId: string) => {
    setSettingsServerId(serverId)
    window.localStorage.setItem(SETTINGS_TARGET_KEY, serverId)
  }, [])

  useEffect(() => {
    if (
      settingsServerId !== LOCAL_SERVER_ID &&
      !remoteConnections.some(connection => connection.id === settingsServerId)
    ) {
      setSettingsServerId(LOCAL_SERVER_ID)
      window.localStorage.setItem(SETTINGS_TARGET_KEY, LOCAL_SERVER_ID)
    }
  }, [remoteConnections, settingsServerId])

  const searchResults = useMemo(
    () => searchPreferenceEntries(searchValue, 30),
    [searchValue]
  )
  const groupedResults = useMemo(
    () => groupResultsByPane(searchResults),
    [searchResults]
  )
  const isSearching = searchValue.trim().length > 0
  const effectiveSearchSelection =
    searchOpen &&
    isSearching &&
    searchResults.some(result => result.id === searchSelection)
      ? searchSelection
      : searchOpen && isSearching
        ? (searchResults[0]?.id ?? '')
        : ''

  const resetSearch = useCallback((options?: { blurActive?: boolean }) => {
    setSearchValue('')
    setSearchOpen(false)
    setSearchSelection('')
    if (options?.blurActive && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }, [])

  const handlePaneSelect = useCallback(
    (pane: PreferencePane) => {
      resetSearch()
      pendingJumpRef.current = null
      setSearchTargetAction(null)
      setSearchTargetPromptKey(null)
      setActivePane(pane)
    },
    [resetSearch]
  )

  const lastBackendRef = useRef<BackendPane>('claude')
  useEffect(() => {
    if (isBackendPane(activePane)) lastBackendRef.current = activePane
  }, [activePane])

  const handleNavigationSelect = useCallback(
    (id: NavigationId) => {
      if (id !== 'backends') {
        handlePaneSelect(id)
      } else if (!isBackendPane(activePane)) {
        handlePaneSelect(lastBackendRef.current)
      }
    },
    [activePane, handlePaneSelect]
  )

  const handleSearchResultSelect = useCallback(
    (entry: PreferenceSearchEntry) => {
      setActivePane(entry.pane)
      resetSearch()
      pendingJumpRef.current = entry
      setPendingJumpTick(t => t + 1)
      setSearchTargetAction(entry.keybindingAction ?? null)
      setSearchTargetPromptKey(entry.detailKey ?? null)
    },
    [resetSearch]
  )

  // Handle open state change and navigate to specific pane if requested
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setActivePane('general')
        setSearchValue('')
        setSearchOpen(false)
        pendingJumpRef.current = null
        setSearchTargetAction(null)
        setSearchTargetPromptKey(null)
      }
      setPreferencesOpen(open)
    },
    [setPreferencesOpen]
  )

  // Sync activePane from preferencesPane when dialog opens to a specific pane
  useEffect(() => {
    if (preferencesOpen && preferencesPane) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActivePane(preferencesPane)
    }
  }, [preferencesOpen, preferencesPane])

  // Scroll-to and highlight on pending jump. Retries across RAF frames so
  // newly-mounted panes (especially heavy ones like GeneralPane) have time to
  // commit DOM. Uses an instant initial jump plus a ResizeObserver on the pane
  // wrapper to re-anchor while async content (TanStack Query data, CLI status,
  // auth, preferences) finishes loading and pushes the target down. Observer
  // stops on any user scroll gesture so we don't fight them.
  useEffect(() => {
    const jump = pendingJumpRef.current
    if (!jump) return
    if (jump.pane !== activePane) return
    // Clear the ref now so repeated effect runs (e.g. from pane state updates)
    // don't re-trigger scrolling.
    pendingJumpRef.current = null

    const log = (msg: string, data?: unknown) => {
      // eslint-disable-next-line no-console
      console.log(`[pref-scroll] ${msg}`, data ?? '')
    }

    const anchorId = jump.anchorId ?? jump.fallbackAnchorId
    log('effect start', {
      entryId: jump.id,
      pane: jump.pane,
      activePane,
      anchorId,
      anchorFromEntry: jump.anchorId,
      fallback: jump.fallbackAnchorId,
    })
    if (!anchorId) {
      log('no anchorId, bail')
      return
    }

    const SCROLL_TOP_PADDING = 16
    const MAX_ATTEMPTS = 20
    const REALIGN_WINDOW_MS = 1500
    let attempts = 0
    let rafId: number | null = null
    let cancelled = false
    let observer: ResizeObserver | null = null
    let realignTimeout: ReturnType<typeof setTimeout> | null = null
    let userInterrupted = false

    const performScroll = (
      target: HTMLElement,
      container: HTMLElement,
      tag: string
    ) => {
      const containerRect = container.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offset = targetRect.top - containerRect.top - SCROLL_TOP_PADDING
      const newTop = container.scrollTop + offset
      log(`scroll (${tag})`, {
        containerTop: containerRect.top,
        containerHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
        scrollTopBefore: container.scrollTop,
        targetTop: targetRect.top,
        targetOffsetTop: target.offsetTop,
        offset,
        newTop,
        overflowY: getComputedStyle(container).overflowY,
      })
      container.scrollTo({ top: newTop, behavior: 'auto' })
      window.requestAnimationFrame(() => {
        log(`scrollTop after (${tag})`, container.scrollTop)
      })
    }

    const realign = () => {
      if (cancelled || userInterrupted) return
      const target = document.getElementById(anchorId)
      const container = scrollContainerRef.current
      if (target && container) performScroll(target, container, 'realign')
    }

    const stopRealignment = () => {
      if (userInterrupted) return
      userInterrupted = true
      log('stopRealignment')
      if (observer) {
        observer.disconnect()
        observer = null
      }
      if (realignTimeout) {
        clearTimeout(realignTimeout)
        realignTimeout = null
      }
      const container = scrollContainerRef.current
      if (container) {
        container.removeEventListener('wheel', stopRealignment)
        container.removeEventListener('touchstart', stopRealignment)
        container.removeEventListener('keydown', stopRealignment)
      }
    }

    const tryScroll = () => {
      if (cancelled) return
      const target = document.getElementById(anchorId)
      const container = scrollContainerRef.current

      log(`tryScroll attempt ${attempts}`, {
        targetFound: !!target,
        containerFound: !!container,
        targetTagName: target?.tagName,
        targetClass: target?.className,
      })

      const closedSection = target?.closest(
        '[data-slot="collapsible-content"][hidden]'
      )
      if (closedSection) {
        closedSection
          .closest('[data-slot="collapsible"]')
          ?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
          ?.click()
        rafId = window.requestAnimationFrame(tryScroll)
        return
      }

      if (target && container) {
        performScroll(target, container, 'initial')

        target.classList.add('settings-search-highlight')
        const onEnd = () => {
          target.classList.remove('settings-search-highlight')
          target.removeEventListener('animationend', onEnd)
        }
        target.addEventListener('animationend', onEnd)

        const paneWrapper = document.getElementById(`pref-pane-${jump.pane}`)
        log('pane wrapper', {
          id: `pref-pane-${jump.pane}`,
          found: !!paneWrapper,
        })
        if (paneWrapper) {
          observer = new ResizeObserver(() => {
            log('ResizeObserver fired')
            realign()
          })
          observer.observe(paneWrapper)
        }

        container.addEventListener('wheel', stopRealignment, { passive: true })
        container.addEventListener('touchstart', stopRealignment, {
          passive: true,
        })
        container.addEventListener('keydown', stopRealignment)

        realignTimeout = setTimeout(stopRealignment, REALIGN_WINDOW_MS)
        return
      }

      if (attempts++ < MAX_ATTEMPTS) {
        rafId = window.requestAnimationFrame(tryScroll)
      } else {
        log('gave up after max attempts', { anchorId })
      }
    }

    rafId = window.requestAnimationFrame(tryScroll)

    return () => {
      cancelled = true
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      stopRealignment()
    }
  }, [activePane, pendingJumpTick])

  // Close search dropdown on click outside
  useEffect(() => {
    if (!searchOpen) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      const inDesktop = searchContainerRef.current?.contains(target) ?? false
      const inMobile =
        mobileSearchContainerRef.current?.contains(target) ?? false
      if (!inDesktop && !inMobile) {
        setSearchOpen(false)
      }
    }
    // Use click instead of mousedown so header actions like the dialog close
    // button still receive their own click event before search state updates.
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [searchOpen])

  // "/" and Cmd+F keyboard shortcuts to focus search when dialog is open
  useEffect(() => {
    if (!preferencesOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return

      if (
        e.key === '/' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault()
        searchInputRef.current?.focus()
        setSearchOpen(true)
      }
      if (
        e.key.toLowerCase() === 'f' &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault()
        searchInputRef.current?.focus()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [preferencesOpen])

  const handleDialogEscape = useCallback(
    (e: KeyboardEvent) => {
      if (!searchOpen) return

      const activeElement = document.activeElement
      const isSearchFocused =
        (activeElement instanceof Element &&
          searchContainerRef.current?.contains(activeElement)) ||
        (activeElement instanceof Element &&
          mobileSearchContainerRef.current?.contains(activeElement))

      if (!isSearchFocused) return

      e.preventDefault()
      e.stopPropagation()
      resetSearch({ blurActive: true })
    },
    [resetSearch, searchOpen]
  )

  return (
    <SettingsTargetProvider serverId={settingsServerId}>
      <Dialog open={preferencesOpen} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          aria-modal={true}
          onEscapeKeyDown={handleDialogEscape}
          className="flex h-[94dvh] max-h-[94dvh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:h-[94dvh] sm:max-h-[94dvh] sm:w-[96vw] sm:max-w-[96vw]"
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <SidebarProvider className="!min-h-0 !h-full flex-1 items-stretch overflow-hidden">
            <Sidebar
              collapsible="none"
              className="hidden md:flex border-r border-border"
            >
              <div className="flex h-14 shrink-0 items-center px-4 text-sm font-semibold">
                Jean{' '}
                <span className="ml-2 font-normal text-muted-foreground">
                  Settings
                </span>
              </div>
              <div className="px-3 pb-3">
                <PreferencesSearchBar
                  variant="desktop"
                  searchValue={searchValue}
                  onSearchValueChange={setSearchValue}
                  searchOpen={searchOpen}
                  onSearchOpenChange={setSearchOpen}
                  selectedId={effectiveSearchSelection}
                  onSelectedIdChange={setSearchSelection}
                  isSearching={isSearching}
                  searchResults={searchResults}
                  groupedResults={groupedResults}
                  paneIconMap={paneIconMap}
                  onResultSelect={handleSearchResultSelect}
                  inputRef={searchInputRef}
                  containerRef={searchContainerRef}
                />
              </div>
              {showServerTarget && (
                <div className="px-3 pb-1 pt-3">
                  <Select
                    value={settingsServerId}
                    onValueChange={handleSettingsServerChange}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Settings server"
                      className="w-full rounded-lg border-border/50 bg-muted/50 px-2 text-xs text-muted-foreground shadow-none hover:bg-muted/80 hover:text-foreground"
                    >
                      <Server className="size-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value={LOCAL_SERVER_ID}>Local</SelectItem>
                      {remoteConnections.map(connection => {
                        const status = serverSnapshots.get(
                          connection.id
                        )?.status
                        const statusLabel =
                          status && status !== 'online'
                            ? ` (${status.replace('-', ' ')})`
                            : ''
                        return (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.name}
                            {statusLabel}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {navigationItems.map(item => (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            asChild
                            isActive={
                              navigationIdForPane(activePane) === item.id
                            }
                          >
                            <button
                              type="button"
                              onClick={() => handleNavigationSelect(item.id)}
                              className="w-full"
                            >
                              <item.icon />
                              <span>{item.name}</span>
                            </button>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>

            <main className="flex flex-1 flex-col overflow-hidden">
              <header className="flex h-14 shrink-0 items-center gap-2">
                <div className="flex flex-1 items-center gap-2 px-4">
                  {/* Mobile pane selector */}
                  <Select
                    value={navigationIdForPane(activePane)}
                    onValueChange={v =>
                      handleNavigationSelect(v as NavigationId)
                    }
                  >
                    <SelectTrigger className="md:hidden w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mobileNavigationItems.map(item => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <ModalCloseButton
                    size="lg"
                    className="md:hidden"
                    onClick={() => handleOpenChange(false)}
                  />
                  <Breadcrumb className="hidden md:block">
                    <BreadcrumbList>
                      <BreadcrumbItem>Settings</BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>
                          {navigationName(activePane)}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>

                  <div className="ml-auto hidden md:flex items-center gap-2">
                    <ModalCloseButton
                      className="relative z-10 shrink-0"
                      onClick={() => handleOpenChange(false)}
                    />
                  </div>
                </div>
              </header>

              <div
                ref={scrollContainerRef}
                className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-8 lg:px-12 lg:py-10 min-h-0 [&>div[id^=pref-pane]]:mx-auto [&>div[id^=pref-pane]]:w-full [&>div[id^=pref-pane]]:max-w-4xl"
              >
                <PreferencesSearchBar
                  variant="mobile"
                  searchValue={searchValue}
                  onSearchValueChange={setSearchValue}
                  searchOpen={searchOpen}
                  onSearchOpenChange={setSearchOpen}
                  selectedId={effectiveSearchSelection}
                  onSelectedIdChange={setSearchSelection}
                  isSearching={isSearching}
                  searchResults={searchResults}
                  groupedResults={groupedResults}
                  paneIconMap={paneIconMap}
                  onResultSelect={handleSearchResultSelect}
                  containerRef={mobileSearchContainerRef}
                />

                {activePane === 'general' && (
                  <div id="pref-pane-general" className="min-w-0 max-w-full">
                    <GeneralPane />
                  </div>
                )}
                {isBackendPane(activePane) && (
                  <div id="pref-pane-backends" className="min-w-0 max-w-full">
                    <BackendsPane
                      backend={activePane}
                      onBackendChange={handlePaneSelect}
                    />
                  </div>
                )}
                {activePane === 'appearance' && (
                  <div id="pref-pane-appearance" className="min-w-0 max-w-full">
                    <AppearancePane />
                  </div>
                )}
                {activePane === 'keybindings' && (
                  <div
                    id="pref-pane-keybindings"
                    className="min-w-0 max-w-full"
                  >
                    <KeybindingsPane searchTargetAction={searchTargetAction} />
                  </div>
                )}
                {activePane === 'terminal' && (
                  <div id="pref-pane-terminal" className="min-w-0 max-w-full">
                    <TerminalPane />
                  </div>
                )}
                {activePane === 'magic-prompts' && (
                  <div
                    id="pref-pane-magic-prompts"
                    className="min-w-0 max-w-full"
                  >
                    <MagicPromptsPane
                      searchTargetPromptKey={searchTargetPromptKey}
                    />
                  </div>
                )}
                {activePane === 'mcp-servers' && (
                  <div
                    id="pref-pane-mcp-servers"
                    className="min-w-0 max-w-full"
                  >
                    <McpServersPane />
                  </div>
                )}
                {activePane === 'usage' && (
                  <div id="pref-pane-usage" className="min-w-0 max-w-full">
                    <UsagePane />
                  </div>
                )}
                {activePane === 'integrations' && (
                  <div
                    id="pref-pane-integrations"
                    className="min-w-0 max-w-full"
                  >
                    <IntegrationsPane />
                  </div>
                )}
                {activePane === 'opinionated' && (
                  <div
                    id="pref-pane-opinionated"
                    className="min-w-0 max-w-full"
                  >
                    <OpinionatedPane />
                  </div>
                )}
                {activePane === 'web-access' && (
                  <div id="pref-pane-web-access" className="min-w-0 max-w-full">
                    <WebAccessPane />
                  </div>
                )}
              </div>
            </main>
          </SidebarProvider>
        </DialogContent>
      </Dialog>
    </SettingsTargetProvider>
  )
}

export default PreferencesDialog
