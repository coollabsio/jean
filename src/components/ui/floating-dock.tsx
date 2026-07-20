import {
  Fragment,
  useState,
  useEffect,
  useCallback,
  useSyncExternalStore,
} from 'react'
import {
  LayoutDashboard,
  Command,
  CircleHelp,
  Copy,
  Menu,
  Plus,
  Archive,
  FileText,
  Github,
  GitPullRequest,
  ShieldAlert,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'
import { invoke } from '@/lib/transport'
import { useWsConnectionStatus } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import { openExternal, preOpenWindow } from '@/lib/platform'
import { copyToClipboard } from '@/lib/clipboard'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { chatQueryKeys } from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { useWorktree, type GitHubRemote } from '@/services/projects'
import {
  useClaudeCliAuth,
  useClaudeCliStatus,
  useClaudeUsage,
} from '@/services/claude-cli'
import {
  useCodexCliAuth,
  useCodexCliStatus,
  useCodexUsage,
} from '@/services/codex-cli'
import {
  useGrokCliAuth,
  useGrokCliStatus,
  useGrokUsage,
} from '@/services/grok-cli'
import type { WorktreeSessions } from '@/types/chat'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import type { KeybindingHint } from '@/components/ui/keybinding-hints'
import { getResumeCommand } from '@/components/chat/session-card-utils'
import { ClaudeIcon } from '@/components/icons/ClaudeIcon'
import { CodexIcon } from '@/components/icons/CodexIcon'
import { GrokIcon } from '@/components/icons/GrokIcon'

// Canvas-specific hints (used in ProjectCanvasView)
const CANVAS_HINTS: KeybindingHint[] = [
  { shortcut: 'Enter', label: 'open' },
  {
    shortcut: DEFAULT_KEYBINDINGS.open_in_modal as string,
    label: 'open in...',
  },
  {
    shortcut: DEFAULT_KEYBINDINGS.new_worktree as string,
    label: 'new worktree',
  },
  { shortcut: DEFAULT_KEYBINDINGS.new_session as string, label: 'new session' },
  {
    shortcut: DEFAULT_KEYBINDINGS.toggle_session_label as string,
    label: 'label',
  },
  { shortcut: DEFAULT_KEYBINDINGS.open_magic_modal as string, label: 'magic' },
  {
    shortcut: DEFAULT_KEYBINDINGS.close_session_or_worktree as string,
    label: 'close',
  },
]

function KeybindingHintsButton({
  hints,
  side = 'top',
}: {
  hints: KeybindingHint[]
  side?: 'top' | 'right'
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <CircleHelp className="size-4" />
          <span className="sr-only">Keyboard shortcuts</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        className="w-auto min-w-[200px] p-3"
      >
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-center">
          {hints.map(hint => (
            <Fragment key={hint.shortcut}>
              <Kbd className="h-5 px-1.5 text-[11px]">
                {formatShortcutDisplay(hint.shortcut)}
              </Kbd>
              <span className="text-xs text-muted-foreground">
                {hint.label}
              </span>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ConnectionIndicator() {
  const connected = useWsConnectionStatus()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="inline-flex h-7 items-center gap-1.5 px-2 text-[11px] leading-none text-muted-foreground">
          <span
            className={`inline-block size-2 ${connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        {connected ? 'Connected to server' : 'Reconnecting to server'}
      </TooltipContent>
    </Tooltip>
  )
}

const WIDE_BREAKPOINT = 1280
const lgQuery = `(min-width: ${WIDE_BREAKPOINT}px)`
function subscribeLg(cb: () => void) {
  const mql = window.matchMedia(lgQuery)
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}
function snapshotLg() {
  return window.matchMedia(lgQuery).matches
}
const serverLg = () => true

export function FloatingDock() {
  const chatToolbarMounted = useUIStore(state => state.chatToolbarMounted)
  const isMobile = useIsMobile()
  const isLg = useSyncExternalStore(subscribeLg, snapshotLg, serverLg)
  const { data: preferences } = usePreferences()
  const queryClient = useQueryClient()

  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const sessionChatModalOpen = useUIStore(state => state.sessionChatModalOpen)
  const sessionChatModalWorktreeId = useUIStore(
    state => state.sessionChatModalWorktreeId
  )
  const currentWorktreeId = sessionChatModalOpen
    ? (sessionChatModalWorktreeId ?? activeWorktreeId ?? selectedWorktreeId)
    : (activeWorktreeId ?? selectedWorktreeId)
  const { data: worktree } = useWorktree(isMobile ? currentWorktreeId : null)
  const modalTerminalDockMode = useTerminalStore(
    state => state.modalTerminalDockMode
  )
  const modalTerminalHeight = useTerminalStore(
    state => state.modalTerminalHeight
  )
  const modalTerminalOpen = useTerminalStore(state =>
    currentWorktreeId
      ? (state.modalTerminalOpen[currentWorktreeId] ?? false)
      : false
  )
  const activeSessionId = useChatStore(state =>
    currentWorktreeId ? state.activeSessionIds[currentWorktreeId] : undefined
  )
  const isTerminalSession = useUIStore(state =>
    activeSessionId
      ? state.sessionPrimarySurface[activeSessionId] === 'terminal'
      : false
  )
  const selectedBackend = useChatStore(state =>
    activeSessionId ? state.selectedBackends[activeSessionId] : undefined
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [usageMenuOpen, setUsageMenuOpen] = useState(false)
  const [resumeCommand, setResumeCommand] = useState<string | null>(null)
  const shouldFetchUsage = !import.meta.env.DEV || usageMenuOpen

  const activeBackend = (selectedBackend ??
    preferences?.default_backend ??
    'claude') as
    | 'claude'
    | 'codex'
    | 'opencode'
    | 'cursor'
    | 'pi'
    | 'commandcode'
    | 'grok'

  const claudeStatus = useClaudeCliStatus()
  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeStatus.data?.installed,
  })
  const claudeUsage = useClaudeUsage({
    enabled:
      !!claudeStatus.data?.installed &&
      !!claudeAuth.data?.authenticated &&
      shouldFetchUsage,
  })

  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({
    enabled: !!codexStatus.data?.installed,
  })
  const codexUsage = useCodexUsage({
    enabled:
      !!codexStatus.data?.installed &&
      !!codexAuth.data?.authenticated &&
      shouldFetchUsage,
  })

  const grokStatus = useGrokCliStatus()
  const grokAuth = useGrokCliAuth({
    enabled: !!grokStatus.data?.installed,
  })
  const grokUsage = useGrokUsage({
    enabled:
      !!grokStatus.data?.installed &&
      !!grokAuth.data?.authenticated &&
      shouldFetchUsage,
  })

  // Only installed + authenticated backends appear in the usage menu.
  const usageEntries = [
    {
      id: 'claude' as const,
      label: 'Claude',
      Icon: ClaudeIcon,
      plan: claudeUsage.data?.planType ?? null,
      session: claudeUsage.data?.session?.usedPercent ?? null,
      weekly: claudeUsage.data?.weekly?.usedPercent ?? null,
      available:
        !!claudeStatus.data?.installed && !!claudeAuth.data?.authenticated,
    },
    {
      id: 'codex' as const,
      label: 'Codex',
      Icon: CodexIcon,
      plan: codexUsage.data?.planType ?? null,
      session: codexUsage.data?.session?.usedPercent ?? null,
      weekly: codexUsage.data?.weekly?.usedPercent ?? null,
      available:
        !!codexStatus.data?.installed && !!codexAuth.data?.authenticated,
    },
    {
      id: 'grok' as const,
      label: 'Grok',
      Icon: GrokIcon,
      plan: grokUsage.data?.planType ?? null,
      session: grokUsage.data?.session?.usedPercent ?? null,
      weekly: grokUsage.data?.weekly?.usedPercent ?? null,
      available:
        !!grokStatus.data?.installed && !!grokAuth.data?.authenticated,
    },
  ].filter(entry => entry.available)

  const activeUsageEntry =
    usageEntries.find(entry => entry.id === activeBackend) ??
    usageEntries[0] ??
    null

  const usageBadge = (() => {
    const session = activeUsageEntry?.session ?? null
    const weekly = activeUsageEntry?.weekly ?? null
    const sessionText = session === null ? '--' : `${Math.round(session)}`
    const weeklyText = weekly === null ? '--' : `${Math.round(weekly)}`
    return {
      text: `${sessionText}|${weeklyText}%`,
    }
  })()

  const getActiveResumeCommand = useCallback(() => {
    const { selectedWorktreeId: currentWorktreeId } =
      useProjectsStore.getState()
    if (!currentWorktreeId) return null

    const activeSessionId =
      useChatStore.getState().activeSessionIds[currentWorktreeId]
    if (!activeSessionId) return null

    const cached =
      queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(currentWorktreeId)
      ) ??
      queryClient.getQueryData<WorktreeSessions>([
        ...chatQueryKeys.sessions(currentWorktreeId),
        'with-counts',
      ])
    const session = cached?.sessions?.find(s => s.id === activeSessionId)
    return session ? getResumeCommand(session) : null
  }, [queryClient])

  const handleQuickMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open)
      if (open) {
        setResumeCommand(getActiveResumeCommand())
      }
    },
    [getActiveResumeCommand]
  )

  const toggleMenu = useCallback(() => {
    setMenuOpen(prev => {
      const next = !prev
      if (next) {
        setResumeCommand(getActiveResumeCommand())
      }
      return next
    })
  }, [getActiveResumeCommand])

  const handleCopyResumeCommand = useCallback(() => {
    const commandToCopy = getActiveResumeCommand() ?? resumeCommand
    if (!commandToCopy) return
    void copyToClipboard(commandToCopy)
      .then(() => toast.success('Resume command copied'))
      .catch(() => toast.error('Failed to copy resume command'))
  }, [getActiveResumeCommand, resumeCommand])

  const handleOpenGitHub = useCallback(() => {
    const branch = worktree?.branch
    if (!branch) {
      if (isNativeApp()) {
        if (selectedProjectId) {
          invoke('open_project_on_github', { projectId: selectedProjectId })
        }
      } else {
        // Web access: get URL and open client-side (open_project_on_github opens on the server)
        const targetPath = worktree?.path
        if (targetPath) {
          const win = preOpenWindow()
          invoke<string>('get_github_repo_url', { repoPath: targetPath })
            .then(url => openExternal(url, win))
            .catch(() => {
              win?.close()
              toast.error('Failed to open GitHub')
            })
        }
      }
      return
    }
    const targetPath = worktree?.path
    if (!targetPath) return
    // Pre-open window to avoid mobile popup blockers
    const win = preOpenWindow()
    invoke<GitHubRemote[]>('get_github_remotes', { repoPath: targetPath })
      .then(remotes => {
        if (!remotes || remotes.length <= 1) {
          const url = remotes?.[0]?.url
          if (url) openExternal(`${url}/tree/${branch}`, win)
          else win?.close()
        } else {
          win?.close()
          useUIStore.getState().openRemotePicker(targetPath, remoteName => {
            const remote = remotes.find(r => r.name === remoteName)
            if (remote) openExternal(`${remote.url}/tree/${branch}`)
          })
        }
      })
      .catch(() => {
        win?.close()
        toast.error('Failed to fetch remotes')
      })
  }, [worktree?.branch, worktree?.path, selectedProjectId])

  const handleOpenPR = useCallback(() => {
    if (worktree?.pr_url) openExternal(worktree.pr_url)
  }, [worktree?.pr_url])

  const handleOpenSecurityAlert = useCallback(() => {
    const url = worktree?.security_alert_url ?? worktree?.advisory_url
    if (url) openExternal(url)
  }, [worktree?.security_alert_url, worktree?.advisory_url])

  // Listen for keyboard shortcut event
  useEffect(() => {
    const handler = () => toggleMenu()
    window.addEventListener('toggle-quick-menu', handler)
    return () => window.removeEventListener('toggle-quick-menu', handler)
  }, [toggleMenu])

  const toggleUsageMenu = useCallback(() => {
    setUsageMenuOpen(prev => !prev)
  }, [])

  useEffect(() => {
    const handler = () => toggleUsageMenu()
    window.addEventListener('toggle-usage-menu', handler)
    return () => window.removeEventListener('toggle-usage-menu', handler)
  }, [toggleUsageMenu])

  const githubShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_github_dashboard ??
      DEFAULT_KEYBINDINGS.open_github_dashboard) as string
  )

  const menuShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_quick_menu ??
      DEFAULT_KEYBINDINGS.open_quick_menu) as string
  )

  const usageShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_usage_dropdown ??
      DEFAULT_KEYBINDINGS.open_usage_dropdown) as string
  )
  const isWebAccess = !isNativeApp()
  const showConnectionIndicator = isWebAccess && !isMobile
  const showKeybindingHints = isNativeApp() && !isMobile
  const popoverSide = isMobile || isLg ? 'top' : ('right' as const)
  const popoverAlign = isMobile ? 'end' : ('start' as const)
  const bottomOffset =
    sessionChatModalOpen &&
    modalTerminalOpen &&
    modalTerminalDockMode === 'bottom'
      ? `calc(${modalTerminalHeight + 8}px + var(--safe-area-bottom))`
      : 'calc(8px + var(--safe-area-bottom))'

  // When the chat toolbar is mounted, the DockBurgerButton there exposes the
  // same menu — hide this corner dock to avoid duplicate UI and overlap with
  // the chat textarea.
  // Terminal sessions are full-screen inside the chat bounds and have no
  // bottom input/toolbar, so the corner dock would cover terminal output.
  if (chatToolbarMounted || isTerminalSession) return null

  return (
    <div
      className="absolute right-4 z-10 flex flex-row items-center gap-0.5 rounded-lg border border-border bg-muted/50 px-1 py-0.5 transition-[bottom] duration-200 sm:left-4 sm:right-auto sm:flex-col sm:px-0.5 sm:py-1 xl:flex-row xl:px-1 xl:py-0.5"
      style={{ bottom: bottomOffset }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={handleQuickMenuOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
              >
                <Menu className="size-4" />
                <span className="sr-only">Quick menu</span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={popoverSide}>
            Menu{' '}
            <kbd className="ml-1 text-[0.625rem] opacity-60">
              {menuShortcut}
            </kbd>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side={popoverSide}
          align={popoverAlign}
          className="min-w-[200px]"
          onEscapeKeyDown={e => e.stopPropagation()}
        >
          <DropdownMenuItem
            onClick={() =>
              useProjectsStore.getState().setAddProjectDialogOpen(true)
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Project
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('command:open-archived-modal')
              )
            }
          >
            <Archive className="mr-2 h-4 w-4" />
            Archives
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => useUIStore.getState().setGitHubDashboardOpen(true)}
          >
            <LayoutDashboard className="mr-2 h-4 w-4" />
            GitHub Dashboard
            <DropdownMenuShortcut>{githubShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {resumeCommand && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleCopyResumeCommand}>
                <Copy className="mr-2 h-4 w-4" />
                Native Resume Command
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => window.dispatchEvent(new CustomEvent('open-plan'))}
          >
            <FileText className="mr-2 h-4 w-4" />
            View Plan
          </DropdownMenuItem>
          {isMobile && currentWorktreeId && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleOpenGitHub}>
                <Github className="mr-2 h-4 w-4" />
                GitHub
              </DropdownMenuItem>
              {worktree?.pr_url && (
                <DropdownMenuItem onClick={handleOpenPR}>
                  <GitPullRequest className="mr-2 h-4 w-4" />
                  PR #{worktree.pr_number}
                </DropdownMenuItem>
              )}
              {(worktree?.security_alert_url || worktree?.advisory_url) && (
                <DropdownMenuItem onClick={handleOpenSecurityAlert}>
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  {worktree?.security_alert_number
                    ? `Alert #${worktree.security_alert_number}`
                    : worktree?.advisory_ghsa_id}
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
          >
            <Command className="size-4" />
            <span className="sr-only">Command Palette</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side={popoverSide}>
          Command Palette{' '}
          <kbd className="ml-1 text-[0.625rem] opacity-60">⌘K</kbd>
        </TooltipContent>
      </Tooltip>

      {activeUsageEntry && (
        <DropdownMenu open={usageMenuOpen} onOpenChange={setUsageMenuOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground xl:w-[88px] xl:justify-center xl:px-2"
                >
                  <activeUsageEntry.Icon className="size-4 shrink-0 xl:mr-1 xl:size-3.5" />
                  <span className="hidden text-[11px] leading-none tabular-nums xl:inline">
                    {usageBadge.text}
                  </span>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side={popoverSide}>
              {activeUsageEntry.label} Session|Weekly{' '}
              {showKeybindingHints && (
                <kbd className="ml-1 text-[0.625rem] opacity-60">
                  {usageShortcut}
                </kbd>
              )}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            side={popoverSide}
            align={popoverAlign}
            className="min-w-[180px]"
            onEscapeKeyDown={e => e.stopPropagation()}
          >
            {usageEntries.map(entry => {
              const sessionText =
                entry.session === null ? '--' : `${Math.round(entry.session)}`
              const weeklyText =
                entry.weekly === null ? '--' : `${Math.round(entry.weekly)}`
              const planText =
                entry.plan && entry.plan.trim().length > 0 ? entry.plan : '--'
              return (
                <DropdownMenuItem
                  key={entry.id}
                  onClick={() =>
                    useUIStore.getState().openPreferencesPane('usage')
                  }
                >
                  <entry.Icon className="mr-2 h-4 w-4 shrink-0" />
                  <div className="flex min-w-0 flex-col">
                    <span>{entry.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      Plan: {planText}
                    </span>
                  </div>
                  <DropdownMenuShortcut>
                    {sessionText}|{weeklyText}%
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => useUIStore.getState().openPreferencesPane('usage')}
            >
              Open Usage Details
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showConnectionIndicator && <ConnectionIndicator />}
      {showKeybindingHints && (
        <KeybindingHintsButton hints={CANVAS_HINTS} side={popoverSide} />
      )}
    </div>
  )
}
