import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Settings,
  Palette,
  Keyboard,
  Wand2,
  Plug,
  Blocks,
  BarChart3,
  Puzzle,
  FlaskConical,
  Globe,
  Github,
  Rabbit,
  Sparkles,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
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
import { AntigravityIcon } from '@/components/icons/AntigravityIcon'
import type { CliBackend, MagicPrompts } from '@/types/preferences'
import { GeneralPane } from './panes/GeneralPane'
import { ClaudePane } from './panes/ClaudePane'
import { CodexPane } from './panes/CodexPane'
import { OpenCodePane } from './panes/OpenCodePane'
import { CursorPane } from './panes/CursorPane'
import { PiPane } from './panes/PiPane'
import { CommandCodePane } from './panes/CommandCodePane'
import { GrokPane } from './panes/GrokPane'
import { KimiPane } from './panes/KimiPane'
import { AntigravityPane } from './panes/AntigravityPane'
import { GitHubPane } from './panes/GitHubPane'
import { CodeRabbitPane } from './panes/CodeRabbitPane'
import { AppearancePane } from './panes/AppearancePane'
import { KeybindingsPane } from './panes/KeybindingsPane'
import { TerminalPane } from './panes/TerminalPane'
import { MagicPromptsPane } from './panes/MagicPromptsPane'
import { McpServersPane } from './panes/McpServersPane'
import { ProvidersPane } from './panes/ProvidersPane'
import { UsagePane } from './panes/UsagePane'
import { IntegrationsPane } from './panes/IntegrationsPane'
import { ExperimentalPane } from './panes/ExperimentalPane'
import { WebAccessPane } from './panes/WebAccessPane'
import { OpinionatedPane } from './panes/OpinionatedPane'
import {
  searchPreferenceEntries,
  type PreferenceSearchEntry,
} from './preferences-search'
import { PreferencesSearchBar } from './PreferencesSearchBar'
import { BackendLabel } from '@/components/ui/backend-label'

interface NavigationItem {
  type: 'item'
  id: PreferencePane
  name: string
  icon: LucideIcon
  backend?: CliBackend
  desktopOnly?: boolean
}

interface NavigationSection {
  type: 'section'
  id: string
  label: string
}

type NavigationEntry = NavigationItem | NavigationSection

const navigationEntries: NavigationEntry[] = [
  { type: 'section', id: 'app-section', label: 'App' },
  {
    type: 'item',
    id: 'general',
    name: 'General',
    icon: Settings,
  },
  {
    type: 'item',
    id: 'appearance',
    name: 'Appearance',
    icon: Palette,
  },
  {
    type: 'item',
    id: 'keybindings',
    name: 'Keybindings',
    icon: Keyboard,
    desktopOnly: true,
  },
  { type: 'section', id: 'backends-section', label: 'Backends' },
  {
    type: 'item',
    id: 'claude',
    name: 'Claude',
    icon: ClaudeIcon,
  },
  {
    type: 'item',
    id: 'codex',
    name: 'Codex',
    icon: CodexIcon,
  },
  {
    type: 'item',
    id: 'opencode',
    name: 'OpenCode',
    icon: OpenCodeIcon,
  },
  {
    type: 'item',
    id: 'cursor',
    name: 'Cursor',
    icon: CursorIcon,
  },
  {
    type: 'item',
    id: 'pi',
    name: 'PI',
    icon: PiIcon,
    backend: 'pi',
  },
  {
    type: 'item',
    id: 'commandcode',
    name: 'Command Code',
    icon: CommandCodeIcon,
    backend: 'commandcode',
  },
  {
    type: 'item',
    id: 'grok',
    name: 'Grok',
    icon: GrokIcon,
    backend: 'grok',
  },
  {
    type: 'item',
    id: 'kimi',
    name: 'Kimi Code',
    icon: KimiIcon,
    backend: 'kimi',
  },
  {
    type: 'item',
    id: 'antigravity',
    name: 'Antigravity CLI',
    icon: AntigravityIcon,
    backend: 'antigravity',
  },
  {
    type: 'item',
    id: 'github',
    name: 'GitHub CLI',
    icon: Github,
  },
  {
    type: 'item',
    id: 'coderabbit',
    name: 'CodeRabbit CLI',
    icon: Rabbit,
  },
  { type: 'section', id: 'tools-section', label: 'Tools' },
  {
    type: 'item',
    id: 'terminal',
    name: 'Terminal',
    icon: Terminal,
  },
  {
    type: 'item',
    id: 'magic-prompts',
    name: 'Magic Prompts',
    icon: Wand2,
  },
  {
    type: 'item',
    id: 'opinionated',
    name: 'Opinionated',
    icon: Sparkles,
  },
  { type: 'section', id: 'connectivity-section', label: 'Connectivity' },
  {
    type: 'item',
    id: 'providers',
    name: 'Providers',
    icon: Blocks,
  },
  {
    type: 'item',
    id: 'web-access',
    name: 'Web Access',
    icon: Globe,
    desktopOnly: true,
  },
  {
    type: 'item',
    id: 'mcp-servers',
    name: 'MCP Servers',
    icon: Plug,
  },
  {
    type: 'item',
    id: 'integrations',
    name: 'Integrations',
    icon: Puzzle,
  },
  { type: 'section', id: 'account-section', label: 'Account' },
  {
    type: 'item',
    id: 'usage',
    name: 'Usage',
    icon: BarChart3,
  },
  { type: 'section', id: 'advanced-section', label: 'Advanced' },
  {
    type: 'item',
    id: 'experimental',
    name: 'Experimental',
    icon: FlaskConical,
  },
]

/** Mobile select groups: section labels + non-desktop-only items. */
function getMobileNavigationGroups(): {
  id: string
  label: string
  items: NavigationItem[]
}[] {
  const groups: { id: string; label: string; items: NavigationItem[] }[] = []
  let current: { id: string; label: string; items: NavigationItem[] } | null =
    null

  for (const entry of navigationEntries) {
    if (entry.type === 'section') {
      current = { id: entry.id, label: entry.label, items: [] }
      groups.push(current)
      continue
    }
    if (entry.desktopOnly) continue
    if (!current) {
      current = { id: 'default', label: '', items: [] }
      groups.push(current)
    }
    current.items.push(entry)
  }

  return groups.filter(group => group.items.length > 0)
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
  antigravity: AntigravityIcon,
  github: Github,
  coderabbit: Rabbit,
  opinionated: Sparkles,
  providers: Blocks,
  usage: BarChart3,
  appearance: Palette,
  keybindings: Keyboard,
  terminal: Terminal,
  'magic-prompts': Wand2,
  'mcp-servers': Plug,
  integrations: Puzzle,
  experimental: FlaskConical,
  'web-access': Globe,
}

const getPaneTitle = (pane: PreferencePane): string => {
  switch (pane) {
    case 'general':
      return 'General'
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'OpenCode'
    case 'cursor':
      return 'Cursor'
    case 'pi':
      return 'PI'
    case 'commandcode':
      return 'Command Code'
    case 'github':
      return 'GitHub CLI'
    case 'coderabbit':
      return 'CodeRabbit CLI'
    case 'appearance':
      return 'Appearance'
    case 'keybindings':
      return 'Keybindings'
    case 'terminal':
      return 'Terminal'
    case 'magic-prompts':
      return 'Magic Prompts'
    case 'mcp-servers':
      return 'MCP Servers'
    case 'providers':
      return 'Providers'
    case 'usage':
      return 'Usage'
    case 'integrations':
      return 'Integrations'
    case 'experimental':
      return 'Experimental'
    case 'opinionated':
      return 'Opinionated'
    case 'web-access':
      return 'Web Access'
    default:
      return 'General'
  }
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
    <Dialog open={preferencesOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={handleDialogEscape}
        className="overflow-hidden p-0 !w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-xl font-sans"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your application preferences here.
        </DialogDescription>

        <SidebarProvider className="!min-h-0 !h-full items-stretch overflow-hidden">
          <Sidebar collapsible="none" className="hidden lg:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationEntries.map((entry, index) => {
                      if (entry.type === 'section') {
                        const isFirst = index === 0
                        return (
                          <li key={entry.id} className={isFirst ? 'pt-0' : 'pt-1'}>
                            {!isFirst && (
                              <SidebarSeparator className="mx-0 mb-1" />
                            )}
                            <SidebarGroupLabel className="h-7 px-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                              {entry.label}
                            </SidebarGroupLabel>
                          </li>
                        )
                      }

                      return (
                        <SidebarMenuItem key={entry.id}>
                          <SidebarMenuButton
                            asChild
                            isActive={activePane === entry.id}
                          >
                            <button
                              type="button"
                              onClick={() => handlePaneSelect(entry.id)}
                              className="w-full"
                            >
                              <entry.icon
                                className={
                                  entry.id === 'kimi'
                                    ? 'translate-x-0.5'
                                    : undefined
                                }
                              />
                              {entry.backend ? (
                                <BackendLabel backend={entry.backend} />
                              ) : (
                                <span>{entry.name}</span>
                              )}
                            </button>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border">
              <div className="flex flex-1 items-center gap-2 px-4">
                {/* Mobile pane selector */}
                <Select
                  value={activePane}
                  onValueChange={v => handlePaneSelect(v as PreferencePane)}
                >
                  <SelectTrigger className="lg:hidden w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getMobileNavigationGroups().map(group => (
                      <SelectGroup key={group.id}>
                        <SelectLabel className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {group.label}
                        </SelectLabel>
                        {group.items.map(item => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <ModalCloseButton
                  size="lg"
                  className="lg:hidden"
                  onClick={() => handleOpenChange(false)}
                />
                <Breadcrumb className="hidden lg:block">
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink href="#">Settings</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        {getPaneTitle(activePane)}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>

                <div className="ml-auto hidden lg:flex items-center gap-2">
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

                  <ModalCloseButton
                    className="relative z-10 shrink-0"
                    onClick={() => handleOpenChange(false)}
                  />
                </div>
              </div>
            </header>

            <div
              ref={scrollContainerRef}
              className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4 min-h-0"
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
              {activePane === 'claude' && (
                <div id="pref-pane-claude" className="min-w-0 max-w-full">
                  <ClaudePane />
                </div>
              )}
              {activePane === 'codex' && (
                <div id="pref-pane-codex" className="min-w-0 max-w-full">
                  <CodexPane />
                </div>
              )}
              {activePane === 'opencode' && (
                <div id="pref-pane-opencode" className="min-w-0 max-w-full">
                  <OpenCodePane />
                </div>
              )}
              {activePane === 'cursor' && (
                <div id="pref-pane-cursor" className="min-w-0 max-w-full">
                  <CursorPane />
                </div>
              )}
              {activePane === 'pi' && (
                <div id="pref-pane-pi" className="min-w-0 max-w-full">
                  <PiPane />
                </div>
              )}
              {activePane === 'commandcode' && (
                <div id="pref-pane-commandcode" className="min-w-0 max-w-full">
                  <CommandCodePane />
                </div>
              )}
              {activePane === 'grok' && (
                <div id="pref-pane-grok">
                  <GrokPane />
                </div>
              )}
              {activePane === 'kimi' && (
                <div id="pref-pane-kimi" className="min-w-0 max-w-full">
                  <KimiPane />
                </div>
              )}
              {activePane === 'antigravity' && (
                <div id="pref-pane-antigravity" className="min-w-0 max-w-full">
                  <AntigravityPane />
                </div>
              )}
              {activePane === 'github' && (
                <div id="pref-pane-github" className="min-w-0 max-w-full">
                  <GitHubPane />
                </div>
              )}
              {activePane === 'coderabbit' && (
                <div id="pref-pane-coderabbit" className="min-w-0 max-w-full">
                  <CodeRabbitPane />
                </div>
              )}
              {activePane === 'appearance' && (
                <div id="pref-pane-appearance" className="min-w-0 max-w-full">
                  <AppearancePane />
                </div>
              )}
              {activePane === 'keybindings' && (
                <div id="pref-pane-keybindings" className="min-w-0 max-w-full">
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
                <div id="pref-pane-mcp-servers" className="min-w-0 max-w-full">
                  <McpServersPane />
                </div>
              )}
              {activePane === 'providers' && (
                <div id="pref-pane-providers" className="min-w-0 max-w-full">
                  <ProvidersPane />
                </div>
              )}
              {activePane === 'usage' && (
                <div id="pref-pane-usage" className="min-w-0 max-w-full">
                  <UsagePane />
                </div>
              )}
              {activePane === 'integrations' && (
                <div id="pref-pane-integrations" className="min-w-0 max-w-full">
                  <IntegrationsPane />
                </div>
              )}
              {activePane === 'experimental' && (
                <div id="pref-pane-experimental" className="min-w-0 max-w-full">
                  <ExperimentalPane />
                </div>
              )}
              {activePane === 'opinionated' && (
                <div id="pref-pane-opinionated" className="min-w-0 max-w-full">
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
  )
}

export default PreferencesDialog
