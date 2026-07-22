import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  Copy,
  ExternalLink,
  FolderOpen,
  Github,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Globe,
  Paperclip,
  Play,
  Plug,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Star,
  Terminal,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CustomCliProfile, CliBackend } from '@/types/preferences'
import type {
  EffortLevel,
  McpServerInfo,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import { groupServersByBackend, mcpKey } from '@/services/mcp'
import type {
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
  AttachedSavedContext,
} from '@/types/github'
import type { LoadedLinearIssueContext } from '@/types/linear'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { openExternal, preOpenWindow } from '@/lib/platform'
import { copyToClipboard } from '@/lib/clipboard'
import { invoke } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import {
  CODEX_EFFORT_LEVEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  GROK_EFFORT_LEVEL_OPTIONS,
  KIMI_EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  getPrStatusDisplay,
  getProviderDisplayName,
} from '@/components/chat/toolbar/toolbar-utils'
import type { PrDisplayStatus } from '@/types/pr-status'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { BackendLabel } from '@/components/ui/backend-label'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  usePorts,
  useProjects,
  useWorktree,
  type GitHubRemote,
  type PackageScript,
} from '@/services/projects'
import { useGitHubPRs } from '@/services/github'
import { chatQueryKeys } from '@/services/chat'
import { getResumeCommand } from '@/components/chat/session-card-utils'
import type { ModelReasoningCapability } from '@/services/model-catalog'
import { resolvePortUrl } from '@/components/browser/default-tab-url'

interface MobileSettingsMenuProps {
  isDisabled: boolean
  providerLocked?: boolean
  selectedBackend: CliBackend
  selectedProvider: string | null
  backendModelLabel: ReactNode
  backendModelLabelText: string
  hasMultipleBackendModelChoices: boolean
  selectedEffortLevel: EffortLevel
  selectedThinkingLevel: ThinkingLevel
  hideThinkingLevel?: boolean
  useAdaptiveThinking: boolean
  isCodex: boolean
  modelReasoning?: ModelReasoningCapability | null
  customCliProfiles: CustomCliProfile[]

  onOpenBackendModelPicker: () => void
  handleProviderChange: (value: string) => void
  handleEffortLevelChange: (value: string) => void
  handleThinkingLevelChange: (value: string) => void

  loadedIssueContexts: LoadedIssueContext[]
  loadedPRContexts: LoadedPullRequestContext[]
  loadedSecurityContexts: LoadedSecurityAlertContext[]
  loadedAdvisoryContexts: LoadedAdvisoryContext[]
  loadedLinearContexts: LoadedLinearIssueContext[]
  attachedSavedContexts: AttachedSavedContext[]

  handleViewIssue: (ctx: LoadedIssueContext) => void
  handleViewPR: (ctx: LoadedPullRequestContext) => void
  handleViewSecurityAlert: (ctx: LoadedSecurityAlertContext) => void
  handleViewAdvisory: (ctx: LoadedAdvisoryContext) => void
  handleViewLinear: (ctx: LoadedLinearIssueContext) => void
  handleViewSavedContext: (ctx: AttachedSavedContext) => void

  availableMcpServers: McpServerInfo[]
  enabledMcpServers: string[]
  activeMcpCount: number
  onToggleMcpServer: (name: string) => void

  prUrl?: string | null
  prNumber?: number | null
  prDisplayStatus?: PrDisplayStatus | null

  worktreeId?: string | null
  onAttach?: () => void
  runScripts?: string[]
  onRunCommand?: (command: string) => void
  packageScripts?: PackageScript[]
  favoritePackageScripts?: string[]
  onRunPackageScript?: (script: PackageScript) => void
  onToggleFavoritePackageScript?: (scriptName: string) => void
}

export function MobileSettingsMenu({
  isDisabled,
  selectedBackend,
  selectedProvider,
  backendModelLabel,
  backendModelLabelText,
  hasMultipleBackendModelChoices,
  selectedEffortLevel,
  selectedThinkingLevel,
  hideThinkingLevel,
  useAdaptiveThinking,
  isCodex,
  modelReasoning,
  customCliProfiles,
  onOpenBackendModelPicker,
  handleProviderChange,
  handleEffortLevelChange,
  handleThinkingLevelChange,
  loadedIssueContexts,
  loadedPRContexts,
  loadedSecurityContexts,
  loadedAdvisoryContexts,
  loadedLinearContexts,
  attachedSavedContexts,
  handleViewIssue,
  handleViewPR,
  handleViewSecurityAlert,
  handleViewAdvisory,
  handleViewLinear,
  handleViewSavedContext,
  availableMcpServers,
  enabledMcpServers,
  activeMcpCount,
  onToggleMcpServer,
  prUrl,
  prNumber,
  prDisplayStatus,
  worktreeId,
  onAttach,
  runScripts = [],
  onRunCommand,
  packageScripts = [],
  favoritePackageScripts = [],
  onRunPackageScript,
  onToggleFavoritePackageScript,
}: MobileSettingsMenuProps) {
  const isPi = selectedBackend === 'pi'
  const isGrok = selectedBackend === 'grok'
  const isKimi = selectedBackend === 'kimi'
  const singleRunScript =
    runScripts.length === 1 ? (runScripts[0] ?? null) : null
  const favoritePackageScriptSet = useMemo(
    () => new Set(favoritePackageScripts),
    [favoritePackageScripts]
  )
  const sortedPackageScripts = useMemo(
    () =>
      [...packageScripts].sort(
        (a, b) =>
          Number(favoritePackageScriptSet.has(b.name)) -
          Number(favoritePackageScriptSet.has(a.name))
      ),
    [favoritePackageScriptSet, packageScripts]
  )
  const usesEffortControl =
    modelReasoning?.type === 'effort' ||
    (modelReasoning === undefined &&
      (useAdaptiveThinking || isCodex || isPi || isGrok || isKimi))
  const effortLevelOptions =
    modelReasoning?.type === 'effort'
      ? modelReasoning.levels
      : isPi
        ? PI_EFFORT_LEVEL_OPTIONS
        : isCodex
          ? CODEX_EFFORT_LEVEL_OPTIONS
          : isKimi
            ? KIMI_EFFORT_LEVEL_OPTIONS
            : isGrok
              ? GROK_EFFORT_LEVEL_OPTIONS
              : EFFORT_LEVEL_OPTIONS
  const thinkingLevelOptions =
    modelReasoning?.type === 'thinking'
      ? modelReasoning.levels
      : THINKING_LEVEL_OPTIONS
  const displayedEffortLevel =
    modelReasoning?.type === 'effort'
      ? modelReasoning.levels.some(o => o.value === selectedEffortLevel)
        ? selectedEffortLevel
        : modelReasoning.default
      : isCodex || isPi
        ? selectedEffortLevel === 'max'
          ? 'high'
          : selectedEffortLevel === 'ultracode'
            ? 'xhigh'
            : selectedEffortLevel
        : isGrok && selectedEffortLevel === 'ultracode'
          ? 'max'
          : selectedEffortLevel
  const displayedEffortLabel =
    effortLevelOptions.find(o => o.value === displayedEffortLevel)?.label ??
    displayedEffortLevel
  const displayedThinkingLevel =
    modelReasoning?.type === 'thinking' &&
    !modelReasoning.levels.some(o => o.value === selectedThinkingLevel)
      ? modelReasoning.default
      : selectedThinkingLevel
  const displayedThinkingLabel =
    thinkingLevelOptions.find(o => o.value === displayedThinkingLevel)?.label ??
    displayedThinkingLevel
  const hideReasoningControl =
    hideThinkingLevel ||
    modelReasoning === null ||
    selectedBackend === 'commandcode'

  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const [menuOpen, setMenuOpen] = useState(false)
  const [effortSheetOpen, setEffortSheetOpen] = useState(false)
  const [mcpSheetOpen, setMcpSheetOpen] = useState(false)
  const [scriptsSheetOpen, setScriptsSheetOpen] = useState(false)
  const [resumeCommand, setResumeCommand] = useState<string | null>(null)
  const providerDisplayName = getProviderDisplayName(selectedProvider)
  const { data: worktree } = useWorktree(worktreeId ?? null)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
  const { data: ports = [] } = usePorts(worktree?.path ?? null)
  const { data: openPRs } = useGitHubPRs(project?.path ?? null, 'open', {
    enabled: menuOpen && !!project?.path,
  })
  const stackedOnPR =
    worktree?.base_branch && worktree.base_branch !== project?.default_branch
      ? openPRs?.find(pr => pr.headRefName === worktree.base_branch)
      : undefined
  const hasOpenSection = !!worktreeId || ports.length > 0

  const openBackendModelPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => onOpenBackendModelPicker())
  }

  const openEffortPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setEffortSheetOpen(true))
  }

  const openMcpPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setMcpSheetOpen(true))
  }

  const openScriptsPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setScriptsSheetOpen(true))
  }

  const getActiveResumeCommand = useCallback(() => {
    if (!worktreeId) return null
    const sessionId = useChatStore.getState().activeSessionIds[worktreeId]
    if (!sessionId) return null
    const cached =
      queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId)
      ) ??
      queryClient.getQueryData<WorktreeSessions>([
        ...chatQueryKeys.sessions(worktreeId),
        'with-counts',
      ])
    const session = cached?.sessions?.find(s => s.id === sessionId)
    return session ? getResumeCommand(session) : null
  }, [queryClient, worktreeId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open)
      if (open) setResumeCommand(getActiveResumeCommand())
    },
    [getActiveResumeCommand]
  )

  const handleCopyResumeCommand = useCallback(() => {
    const cmd = getActiveResumeCommand() ?? resumeCommand
    if (!cmd) return
    void copyToClipboard(cmd)
      .then(() => toast.success('Resume command copied'))
      .catch(() => toast.error('Failed to copy resume command'))
  }, [getActiveResumeCommand, resumeCommand])

  const handleToggleTerminal = useCallback(() => {
    if (!worktreeId) return
    useTerminalStore.getState().toggleModalTerminal(worktreeId)
  }, [worktreeId])

  const handleRunCommand = useCallback(
    (command: string) => {
      setMenuOpen(false)
      onRunCommand?.(command)
    },
    [onRunCommand]
  )

  const handleOpenGitHub = useCallback(() => {
    const branch = worktree?.branch
    const targetPath = worktree?.path
    if (!branch) {
      if (isNativeApp()) {
        const projectId = useProjectsStore.getState().selectedProjectId
        if (projectId) invoke('open_project_on_github', { projectId })
      } else if (targetPath) {
        const win = preOpenWindow()
        invoke<string>('get_github_repo_url', { repoPath: targetPath })
          .then(url => openExternal(url, win))
          .catch(() => {
            win?.close()
            toast.error('Failed to open GitHub')
          })
      }
      return
    }
    if (!targetPath) return
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
  }, [worktree?.branch, worktree?.path])

  const openPrByNumber = useCallback(
    (number: number) => {
      const targetPath = worktree?.path
      if (!targetPath) return
      const win = preOpenWindow()
      invoke<GitHubRemote[]>('get_github_remotes', { repoPath: targetPath })
        .then(remotes => {
          if (!remotes || remotes.length <= 1) {
            const url = remotes?.[0]?.url
            if (url) openExternal(`${url}/pull/${number}`, win)
            else win?.close()
          } else {
            win?.close()
            useUIStore.getState().openRemotePicker(targetPath, remoteName => {
              const remote = remotes.find(r => r.name === remoteName)
              if (remote) openExternal(`${remote.url}/pull/${number}`)
            })
          }
        })
        .catch(() => {
          win?.close()
          toast.error('Failed to fetch remotes')
        })
    },
    [worktree?.path]
  )

  const hasLinkedPr = !!(prUrl && prNumber) || !!stackedOnPR
  const hasContexts =
    loadedIssueContexts.length > 0 ||
    loadedPRContexts.length > 0 ||
    loadedSecurityContexts.length > 0 ||
    loadedAdvisoryContexts.length > 0 ||
    loadedLinearContexts.length > 0 ||
    attachedSavedContexts.length > 0
  const hasToggleableMcpServers = availableMcpServers.some(
    server => !server.disabled
  )

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Settings"
            className="flex @xl:hidden h-8 items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={isDisabled}
          >
            <Settings className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={isMobile ? 'end' : 'start'}
          className="w-72"
        >
          {customCliProfiles.length > 0 && selectedBackend === 'claude' && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Sparkles className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>Provider</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {providerDisplayName}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider ?? '__anthropic__'}
                  onValueChange={handleProviderChange}
                >
                  <DropdownMenuRadioItem value="__anthropic__">
                    Anthropic
                  </DropdownMenuRadioItem>
                  {customCliProfiles.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs text-muted-foreground">
                        Custom Providers
                      </DropdownMenuLabel>
                      {customCliProfiles.map(profile => (
                        <DropdownMenuRadioItem
                          key={profile.name}
                          value={profile.name}
                        >
                          {profile.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </>
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuItem onSelect={openBackendModelPicker}>
            <Sparkles className="h-4 w-4" />
            <span>Model</span>
            <span
              className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 truncate text-right text-xs text-muted-foreground"
              title={backendModelLabelText}
            >
              {backendModelLabel}
            </span>
            {hasMultipleBackendModelChoices && (
              <ChevronRight className="ml-2 h-4 w-4 shrink-0 text-foreground" />
            )}
          </DropdownMenuItem>

          {hideReasoningControl ? null : usesEffortControl && isMobile ? (
            <DropdownMenuItem onSelect={openEffortPicker}>
              <Brain className="h-4 w-4 text-muted-foreground" />
              <span>Effort</span>
              <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                {displayedEffortLabel}
              </span>
              <ChevronRight className="ml-2 h-4 w-4 shrink-0 text-foreground" />
            </DropdownMenuItem>
          ) : usesEffortControl ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
                <Brain className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>Effort</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                  {displayedEffortLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={displayedEffortLevel}
                  onValueChange={handleEffortLevelChange}
                >
                  {effortLevelOptions.map(option => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                      <span className="ml-auto pl-4 text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
                <Brain className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>Thinking</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                  {displayedThinkingLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={displayedThinkingLevel}
                  onValueChange={handleThinkingLevelChange}
                >
                  {thinkingLevelOptions.map(option => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                      <span className="ml-auto pl-4 text-xs text-muted-foreground">
                        {'tokens' in option
                          ? option.tokens
                          : option.description}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {hasToggleableMcpServers && isMobile ? (
            <DropdownMenuItem onSelect={openMcpPicker}>
              <Plug
                className={cn(
                  'h-4 w-4',
                  activeMcpCount > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-muted-foreground'
                )}
              />
              <span>MCP</span>
              <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                {activeMcpCount > 0 ? `${activeMcpCount} on` : 'Off'}
              </span>
              <ChevronRight className="ml-2 h-4 w-4 shrink-0 text-foreground" />
            </DropdownMenuItem>
          ) : hasToggleableMcpServers ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
                <Plug
                  className={cn(
                    'mr-2 h-4 w-4',
                    activeMcpCount > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-muted-foreground'
                  )}
                />
                <span>MCP</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                  {activeMcpCount > 0 ? `${activeMcpCount} on` : 'Off'}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {(() => {
                  const grouped = groupServersByBackend(availableMcpServers)
                  const backends = Object.keys(grouped) as CliBackend[]
                  const showHeaders = backends.length > 1
                  return backends.map((backend, idx) => (
                    <div key={backend}>
                      {showHeaders && (
                        <>
                          {idx > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium py-1">
                            <BackendLabel
                              backend={backend}
                              badgeClassName="text-[8px] leading-3"
                            />
                          </DropdownMenuLabel>
                        </>
                      )}
                      {(grouped[backend] ?? []).map(server => {
                        const key = mcpKey(backend, server.name)
                        return (
                          <DropdownMenuCheckboxItem
                            key={`${backend}-${server.name}`}
                            checked={
                              !server.disabled &&
                              enabledMcpServers.includes(key)
                            }
                            onCheckedChange={() => onToggleMcpServer(key)}
                            disabled={server.disabled}
                            className={
                              server.disabled ? 'opacity-50' : undefined
                            }
                          >
                            {server.name}
                            <span className="ml-auto pl-4 text-xs text-muted-foreground">
                              {server.disabled ? 'disabled' : server.scope}
                            </span>
                          </DropdownMenuCheckboxItem>
                        )
                      })}
                    </div>
                  ))
                })()}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem disabled>
              <Plug className="h-4 w-4 text-muted-foreground" />
              <span>MCP</span>
              <span className="ml-auto text-xs text-muted-foreground">
                None
              </span>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {onAttach && (
            <DropdownMenuItem
              onSelect={() => {
                setMenuOpen(false)
                onAttach()
              }}
            >
              <Paperclip className="h-4 w-4" />
              Attachments
            </DropdownMenuItem>
          )}
          {worktreeId && (
            <>
              {singleRunScript && (
                <DropdownMenuItem
                  onSelect={() => handleRunCommand(singleRunScript)}
                >
                  <Play className="h-4 w-4" />
                  Run
                </DropdownMenuItem>
              )}
              {runScripts.length > 1 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Play className="mr-2 h-4 w-4" />
                    Run
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {runScripts.map((cmd, i) => (
                      <DropdownMenuItem
                        key={i}
                        onSelect={() => handleRunCommand(cmd)}
                        className="font-mono text-xs"
                      >
                        {cmd}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {packageScripts.length > 0 && (
                <DropdownMenuItem onSelect={openScriptsPicker}>
                  <Play className="h-4 w-4" />
                  <span>Scripts</span>
                  <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-foreground" />
                </DropdownMenuItem>
              )}
            </>
          )}
          {worktreeId && (
            <DropdownMenuItem onSelect={handleToggleTerminal}>
              <Terminal className="h-4 w-4" />
              Terminal
            </DropdownMenuItem>
          )}
          {resumeCommand && (
            <DropdownMenuItem onSelect={handleCopyResumeCommand}>
              <Copy className="h-4 w-4" />
              Native Resume Command
            </DropdownMenuItem>
          )}

          {hasOpenSection && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Open
              </DropdownMenuLabel>
              {worktreeId && (
                <DropdownMenuItem
                  onSelect={() => {
                    setMenuOpen(false)
                    handleOpenGitHub()
                  }}
                >
                  <Github className="h-4 w-4" />
                  GitHub
                  <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
                </DropdownMenuItem>
              )}
              {ports.map(port => {
                const host = port.host?.trim() || 'localhost'
                const url = resolvePortUrl(port)
                const label = port.label?.trim()
                  ? `${port.label} (${host}:${port.port})`
                  : `${host}:${port.port}`
                return (
                  <DropdownMenuItem
                    key={`${host}:${port.port}:${port.label}`}
                    onSelect={() => {
                      setMenuOpen(false)
                      openExternal(url)
                    }}
                  >
                    <Globe className="h-4 w-4" />
                    <span className="truncate">{label}</span>
                    <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
                  </DropdownMenuItem>
                )
              })}
            </>
          )}

          {hasLinkedPr && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Linked
              </DropdownMenuLabel>
              {prUrl && prNumber && (
                <DropdownMenuItem
                  onSelect={() => {
                    setMenuOpen(false)
                    openExternal(prUrl)
                  }}
                >
                  {prDisplayStatus === 'merged' ? (
                    <GitMerge
                      className={cn(
                        'h-4 w-4',
                        getPrStatusDisplay(prDisplayStatus).className
                      )}
                    />
                  ) : (
                    <GitPullRequest
                      className={cn(
                        'h-4 w-4',
                        prDisplayStatus
                          ? getPrStatusDisplay(prDisplayStatus).className
                          : 'text-muted-foreground'
                      )}
                    />
                  )}
                  <span className="truncate">PR #{prNumber}</span>
                  <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
                </DropdownMenuItem>
              )}
              {stackedOnPR && (
                <DropdownMenuItem
                  onSelect={() => {
                    setMenuOpen(false)
                    openPrByNumber(stackedOnPR.number)
                  }}
                >
                  <GitPullRequestArrow className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">
                    Stacked on #{stackedOnPR.number} {stackedOnPR.title}
                  </span>
                </DropdownMenuItem>
              )}
            </>
          )}

          {hasContexts && (
            <>
              <DropdownMenuSeparator />
              {loadedIssueContexts.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Issues
                  </DropdownMenuLabel>
                  {loadedIssueContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.number}
                      onClick={() => {
                        setMenuOpen(false)
                        handleViewIssue(ctx)
                      }}
                    >
                      <CircleDot className="h-4 w-4 text-green-500" />
                      <span className="truncate">
                        #{ctx.number} {ctx.title}
                      </span>
                      <button
                        className="ml-auto shrink-0 rounded p-0.5 hover:bg-accent"
                        onClick={e => {
                          e.stopPropagation()
                          openExternal(
                            `https://github.com/${ctx.repoOwner}/${ctx.repoName}/issues/${ctx.number}`
                          )
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {loadedPRContexts.length > 0 && (
                <>
                  {loadedIssueContexts.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Pull Requests
                  </DropdownMenuLabel>
                  {loadedPRContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.number}
                      onClick={() => {
                        setMenuOpen(false)
                        handleViewPR(ctx)
                      }}
                    >
                      <GitPullRequest className="h-4 w-4 text-green-500" />
                      <span className="truncate">
                        #{ctx.number} {ctx.title}
                      </span>
                      <button
                        className="ml-auto shrink-0 rounded p-0.5 hover:bg-accent"
                        onClick={e => {
                          e.stopPropagation()
                          openExternal(
                            `https://github.com/${ctx.repoOwner}/${ctx.repoName}/pull/${ctx.number}`
                          )
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {loadedSecurityContexts.length > 0 && (
                <>
                  {(loadedIssueContexts.length > 0 ||
                    loadedPRContexts.length > 0) && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Security Alerts
                  </DropdownMenuLabel>
                  {loadedSecurityContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.number}
                      onClick={() => {
                        setMenuOpen(false)
                        handleViewSecurityAlert(ctx)
                      }}
                    >
                      <Shield className="h-4 w-4 text-orange-500" />
                      <span className="truncate">
                        #{ctx.number} {ctx.packageName} ({ctx.severity})
                      </span>
                      <button
                        className="ml-auto shrink-0 rounded p-0.5 hover:bg-accent"
                        onClick={e => {
                          e.stopPropagation()
                          openExternal(
                            `https://github.com/${ctx.repoOwner}/${ctx.repoName}/security/dependabot/${ctx.number}`
                          )
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {loadedAdvisoryContexts.length > 0 && (
                <>
                  {(loadedIssueContexts.length > 0 ||
                    loadedPRContexts.length > 0 ||
                    loadedSecurityContexts.length > 0) && (
                    <DropdownMenuSeparator />
                  )}
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Advisories
                  </DropdownMenuLabel>
                  {loadedAdvisoryContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.ghsaId}
                      onClick={() => {
                        setMenuOpen(false)
                        handleViewAdvisory(ctx)
                      }}
                    >
                      <ShieldAlert className="h-4 w-4 text-orange-500" />
                      <span className="truncate">
                        {ctx.ghsaId} — {ctx.summary}
                      </span>
                      <button
                        className="ml-auto shrink-0 rounded p-0.5 hover:bg-accent"
                        onClick={e => {
                          e.stopPropagation()
                          openExternal(
                            `https://github.com/${ctx.repoOwner}/${ctx.repoName}/security/advisories/${ctx.ghsaId}`
                          )
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {loadedLinearContexts.length > 0 && (
                <>
                  {(loadedIssueContexts.length > 0 ||
                    loadedPRContexts.length > 0 ||
                    loadedSecurityContexts.length > 0 ||
                    loadedAdvisoryContexts.length > 0) && (
                    <DropdownMenuSeparator />
                  )}
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Linear Issues
                  </DropdownMenuLabel>
                  {loadedLinearContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.identifier}
                      onClick={() => {
                        setMenuOpen(false)
                        handleViewLinear(ctx)
                      }}
                    >
                      <LinearIcon className="h-4 w-4 text-violet-500" />
                      <span className="truncate">
                        {ctx.identifier} {ctx.title}
                      </span>
                      {ctx.url && (
                        <button
                          className="ml-auto shrink-0 rounded p-0.5 hover:bg-accent"
                          onClick={e => {
                            e.stopPropagation()
                            if (ctx.url) openExternal(ctx.url)
                          }}
                        >
                          <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                        </button>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {attachedSavedContexts.length > 0 && (
                <>
                  {(loadedIssueContexts.length > 0 ||
                    loadedPRContexts.length > 0 ||
                    loadedSecurityContexts.length > 0 ||
                    loadedAdvisoryContexts.length > 0 ||
                    loadedLinearContexts.length > 0) && (
                    <DropdownMenuSeparator />
                  )}
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Contexts
                  </DropdownMenuLabel>
                  {attachedSavedContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.slug}
                      onClick={() => {
                        setMenuOpen(false)
                        handleViewSavedContext(ctx)
                      }}
                    >
                      <FolderOpen className="h-4 w-4 text-blue-500" />
                      <span className="truncate">{ctx.name || ctx.slug}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet open={effortSheetOpen} onOpenChange={setEffortSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[75svh] overflow-hidden rounded-t-xl p-0"
          showCloseButton={false}
        >
          <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
            <SheetTitle>Select effort</SheetTitle>
            <SheetDescription>
              Choose how much reasoning effort the model should use.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            {effortLevelOptions.map(option => {
              const selected = option.value === displayedEffortLevel
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left active:bg-accent',
                    selected && 'bg-accent'
                  )}
                  aria-pressed={selected}
                  onClick={() => {
                    handleEffortLevelChange(option.value)
                    setEffortSheetOpen(false)
                  }}
                >
                  <span className="flex-1">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0" />}
                </button>
              )
            })}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={scriptsSheetOpen} onOpenChange={setScriptsSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[75svh] overflow-hidden rounded-t-xl p-0"
          showCloseButton={false}
        >
          <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
            <SheetTitle>Scripts</SheetTitle>
            <SheetDescription>
              Run a package.json script in a new terminal.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            {sortedPackageScripts.map(script => (
              <div
                key={script.name}
                className="flex min-h-12 items-center rounded-lg active:bg-accent"
              >
                <button
                  type="button"
                  className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 text-left"
                  onClick={() => {
                    onRunPackageScript?.(script)
                    setScriptsSheetOpen(false)
                  }}
                >
                  <Play className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-sm">
                    {script.name}
                  </span>
                </button>
                <button
                  type="button"
                  className="mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
                  aria-label={`${favoritePackageScriptSet.has(script.name) ? 'Unfavorite' : 'Favorite'} ${script.name}`}
                  aria-pressed={favoritePackageScriptSet.has(script.name)}
                  onClick={() => onToggleFavoritePackageScript?.(script.name)}
                >
                  <Star
                    className={cn(
                      'h-3.5 w-3.5',
                      favoritePackageScriptSet.has(script.name) &&
                        'fill-yellow-500 text-yellow-500'
                    )}
                  />
                </button>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={mcpSheetOpen} onOpenChange={setMcpSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[75svh] overflow-hidden rounded-t-xl p-0"
          showCloseButton={false}
        >
          <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
            <SheetTitle>Manage MCP servers</SheetTitle>
            <SheetDescription>
              Choose which MCP servers are enabled for this session.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            {(() => {
              const grouped = groupServersByBackend(availableMcpServers)
              const backends = Object.keys(grouped) as CliBackend[]
              const showHeaders = backends.length > 1
              return backends.map(backend => (
                <div key={backend}>
                  {showHeaders && (
                    <div className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
                      <BackendLabel backend={backend} />
                    </div>
                  )}
                  {(grouped[backend] ?? []).map(server => {
                    const key = mcpKey(backend, server.name)
                    const enabled =
                      !server.disabled && enabledMcpServers.includes(key)
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={server.disabled}
                        aria-pressed={enabled}
                        className={cn(
                          'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left active:bg-accent disabled:opacity-50',
                          enabled && 'bg-accent'
                        )}
                        onClick={() => onToggleMcpServer(key)}
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block truncate font-medium">
                            {server.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {server.disabled ? 'Disabled' : server.scope}
                          </span>
                        </span>
                        {enabled && <Check className="h-4 w-4 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              ))
            })()}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
