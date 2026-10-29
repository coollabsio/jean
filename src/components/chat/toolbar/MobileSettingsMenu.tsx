import {
  useCallback,
  useMemo,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
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
  MessagesSquare,
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
  Sentry,
} from '@/components/icons/reicon'
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
import type {
  CliBackend,
  CodexProviderProfile,
  CustomCliProfile,
} from '@/types/preferences'
import type {
  EffortLevel,
  McpServerInfo,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import {
  groupServersByBackend,
  invalidateMcpServers,
  isAutoLoadedMcpBackend,
  mcpKey,
} from '@/services/mcp'
import type {
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
  LoadedDiscussionContext,
  AttachedSavedContext,
} from '@/types/github'
import type { LoadedLinearIssueContext } from '@/types/linear'
import type { SentryIssueContext } from '@/types/sentry'
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
  ANTIGRAVITY_EFFORT_LEVEL_OPTIONS,
  MUSE_EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  withAdaptiveEffortOption,
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
import { BackendLabel, getBackendLabel } from '@/components/ui/backend-label'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useWorktreeTerminalStatus } from '@/hooks/useWorktreeTerminalStatus'
import { TerminalActivityIcon } from '@/components/chat/TerminalActivityIcon'
import { useUIStore } from '@/store/ui-store'
import {
  usePorts,
  useProjects,
  useWorktree,
  type GitHubRemote,
  type PackageScript,
} from '@/services/projects'
import { useGitHubPRs } from '@/services/github'
import { providerLabels, useProjectGitProvider } from '@/services/git-provider'
import {
  branchWebUrl,
  hostedRepoWebUrl,
  issueWebUrl,
  pullRequestWebUrl,
} from '@/lib/git-provider'
import { GitLabIcon } from '@/components/icons/GitLabIcon'
import { resolveStackedOnPr } from '@/components/chat/worktree-branch-badge'
import { chatQueryKeys } from '@/services/chat'
import { getResumeCommand } from '@/components/chat/session-card-utils'
import type { ModelReasoningCapability } from '@/services/model-catalog'
import {
  resolvePortHost,
  resolvePortUrl,
} from '@/components/browser/default-tab-url'
import { usePreferences } from '@/services/preferences'
import {
  MobileContextsSheet,
  type MobileContextGroup,
} from './MobileContextsSheet'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Stable defaults so omit/undefined doesn't allocate a new [] each render. */
const EMPTY_CODEX_PROVIDERS: CodexProviderProfile[] = []
const EMPTY_RUN_SCRIPTS: string[] = []
const EMPTY_PACKAGE_SCRIPTS: PackageScript[] = []
const EMPTY_FAVORITE_PACKAGE_SCRIPTS: string[] = []

export interface MobileSettingsMenuHandle {
  /**
   * Open the effort/thinking sheet without reopening the gear menu
   * (issue #574). Does nothing when the model has no reasoning control.
   */
  openReasoningSheet: () => void
}

interface MobileSettingsMenuProps {
  isDisabled: boolean
  providerLocked?: boolean
  selectedBackend: CliBackend
  selectedModel: string
  selectedProvider: string | null
  hideModelPicker?: boolean
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
  customCodexProviders?: CodexProviderProfile[]

  onOpenBackendModelPicker: () => void
  handleProviderChange: (value: string) => void
  handleEffortLevelChange: (value: string) => void
  handleThinkingLevelChange: (value: string) => void
  /** Lets the toolbar open the reasoning sheet after a mobile model pick. */
  ref?: Ref<MobileSettingsMenuHandle>

  loadedIssueContexts: LoadedIssueContext[]
  loadedPRContexts: LoadedPullRequestContext[]
  loadedDiscussionContexts: LoadedDiscussionContext[]
  loadedSecurityContexts: LoadedSecurityAlertContext[]
  loadedAdvisoryContexts: LoadedAdvisoryContext[]
  loadedLinearContexts: LoadedLinearIssueContext[]
  loadedSentryContexts: SentryIssueContext[]
  attachedSavedContexts: AttachedSavedContext[]

  handleViewIssue: (ctx: LoadedIssueContext) => void
  handleViewPR: (ctx: LoadedPullRequestContext) => void
  handleViewDiscussion: (ctx: LoadedDiscussionContext) => void
  handleViewSecurityAlert: (ctx: LoadedSecurityAlertContext) => void
  handleViewAdvisory: (ctx: LoadedAdvisoryContext) => void
  handleViewLinear: (ctx: LoadedLinearIssueContext) => void
  handleViewSentry: (ctx: SentryIssueContext) => void
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
  selectedModel,
  selectedProvider,
  hideModelPicker = false,
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
  customCodexProviders = EMPTY_CODEX_PROVIDERS,
  onOpenBackendModelPicker,
  handleProviderChange,
  handleEffortLevelChange,
  handleThinkingLevelChange,
  ref,
  loadedIssueContexts,
  loadedPRContexts,
  loadedDiscussionContexts,
  loadedSecurityContexts,
  loadedAdvisoryContexts,
  loadedLinearContexts,
  loadedSentryContexts,
  attachedSavedContexts,
  handleViewIssue,
  handleViewPR,
  handleViewDiscussion,
  handleViewSecurityAlert,
  handleViewAdvisory,
  handleViewLinear,
  handleViewSentry,
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
  runScripts = EMPTY_RUN_SCRIPTS,
  onRunCommand,
  packageScripts = EMPTY_PACKAGE_SCRIPTS,
  favoritePackageScripts = EMPTY_FAVORITE_PACKAGE_SCRIPTS,
  onRunPackageScript,
  onToggleFavoritePackageScript,
}: MobileSettingsMenuProps) {
  const isPi = selectedBackend === 'pi'
  const isGrok = selectedBackend === 'grok'
  const isKimi = selectedBackend === 'kimi'
  const isAntigravity = selectedBackend === 'antigravity'
  const isMuse = selectedBackend === 'muse'
  const singleRunScript =
    runScripts.length === 1 ? (runScripts[0] ?? null) : null
  const enabledMcpServersSet = useMemo(
    () => new Set(enabledMcpServers),
    [enabledMcpServers]
  )
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
      (useAdaptiveThinking ||
        isCodex ||
        isPi ||
        isGrok ||
        isKimi ||
        isAntigravity ||
        isMuse))
  const effortLevelOptions =
    modelReasoning?.type === 'effort'
      ? withAdaptiveEffortOption(modelReasoning.levels, selectedModel)
      : isAntigravity
        ? ANTIGRAVITY_EFFORT_LEVEL_OPTIONS
        : isMuse
          ? MUSE_EFFORT_LEVEL_OPTIONS
          : isPi
            ? withAdaptiveEffortOption(PI_EFFORT_LEVEL_OPTIONS, selectedModel)
            : isCodex
              ? withAdaptiveEffortOption(
                  CODEX_EFFORT_LEVEL_OPTIONS,
                  selectedModel
                )
              : isKimi
                ? withAdaptiveEffortOption(
                    KIMI_EFFORT_LEVEL_OPTIONS,
                    selectedModel
                  )
                : isGrok
                  ? withAdaptiveEffortOption(
                      GROK_EFFORT_LEVEL_OPTIONS,
                      selectedModel
                    )
                  : withAdaptiveEffortOption(
                      EFFORT_LEVEL_OPTIONS,
                      selectedModel
                    )
  const thinkingLevelOptions =
    modelReasoning?.type === 'thinking'
      ? withAdaptiveEffortOption(modelReasoning.levels, selectedModel)
      : withAdaptiveEffortOption(THINKING_LEVEL_OPTIONS, selectedModel)
  const effortOptionValues = new Set(effortLevelOptions.map(o => o.value))
  const thinkingOptionValues = new Set(thinkingLevelOptions.map(o => o.value))
  const displayedEffortLevel =
    modelReasoning?.type === 'effort'
      ? effortOptionValues.has(selectedEffortLevel)
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
          : isMuse && !effortOptionValues.has(selectedEffortLevel)
            ? 'high' // Jean omits efforts Muse rejects, so Muse uses its default
            : selectedEffortLevel
  const displayedEffortLabel =
    effortLevelOptions.find(o => o.value === displayedEffortLevel)?.label ??
    displayedEffortLevel
  const displayedThinkingLevel = thinkingOptionValues.has(selectedThinkingLevel)
    ? selectedThinkingLevel
    : modelReasoning?.type === 'thinking'
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
  const [reasoningSheetOpen, setReasoningSheetOpen] = useState(false)
  // One sheet state: the current model decides effort vs thinking at render.
  const effortSheetOpen =
    reasoningSheetOpen && !hideReasoningControl && usesEffortControl
  const thinkingSheetOpen =
    reasoningSheetOpen && !hideReasoningControl && !usesEffortControl
  const [mcpSheetOpen, setMcpSheetOpen] = useState(false)
  const [scriptsSheetOpen, setScriptsSheetOpen] = useState(false)
  const [contextsSheetOpen, setContextsSheetOpen] = useState(false)
  const [resumeCommand, setResumeCommand] = useState<string | null>(null)
  const { hasActiveTerminal } = useWorktreeTerminalStatus(worktreeId ?? '')
  // Keep radio/checkbox selections from dismissing the gear menu so users can
  // chain model/effort/provider/MCP changes without reopening (issue #574).
  const keepMenuOpenOnSelect = useCallback((event: Event) => {
    event.preventDefault()
  }, [])
  const providerDisplayName = getProviderDisplayName(
    selectedProvider,
    selectedBackend
  )
  const showClaudeProviders =
    customCliProfiles.length > 0 && selectedBackend === 'claude'
  const showCodexProviders =
    customCodexProviders.length > 0 && selectedBackend === 'codex'
  const showProviderMenu = showClaudeProviders || showCodexProviders
  const { data: worktree } = useWorktree(worktreeId ?? null)
  const { data: gitProviderInfo } = useProjectGitProvider(worktree?.path)
  const gitProvider = gitProviderInfo?.provider ?? 'github'
  const forgeLabels = providerLabels(gitProvider)
  const forgeHost =
    gitProviderInfo?.host ??
    (gitProvider === 'gitlab' ? 'gitlab.com' : 'github.com')
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
  const { data: ports = [] } = usePorts(worktree?.path ?? null)
  const ownerServerId = worktree?.serverId
  const preferenceServerId =
    ownerServerId && ownerServerId !== LOCAL_SERVER_ID
      ? ownerServerId
      : undefined
  const { data: serverPreferences } = usePreferences(preferenceServerId)
  const serverDefaultHost = serverPreferences?.browser_default_host
  const { data: openPRs } = useGitHubPRs(project?.path ?? null, 'open', {
    enabled: menuOpen && !!project?.path,
    ownerId: project?.id,
  })
  const stackedOnPR = resolveStackedOnPr(
    worktree?.base_branch && worktree.base_branch !== project?.default_branch
      ? worktree.base_branch
      : null,
    openPRs,
    project?.default_branch
  )
  const hasOpenSection = !!worktreeId || ports.length > 0

  const openBackendModelPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => onOpenBackendModelPicker())
  }

  const openReasoningPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setReasoningSheetOpen(true))
  }

  const openMcpPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setMcpSheetOpen(true))
  }

  const openScriptsPicker = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setScriptsSheetOpen(true))
  }

  const openContextsSheet = () => {
    setMenuOpen(false)
    requestAnimationFrame(() => setContextsSheetOpen(true))
  }

  useImperativeHandle(ref, () => ({
    openReasoningSheet: () => {
      if (!hideReasoningControl) openReasoningPicker()
    },
  }))

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
      if (open) {
        setResumeCommand(getActiveResumeCommand())
        // Pick up MCP servers added or signed in to from a terminal in Jean.
        invalidateMcpServers()
      }
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
            toast.error(`Failed to open ${forgeLabels.name}`)
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
          if (url) openExternal(branchWebUrl(url, branch, gitProvider), win)
          else win?.close()
        } else {
          win?.close()
          useUIStore.getState().openRemotePicker(targetPath, remoteName => {
            const remote = remotes.find(r => r.name === remoteName)
            if (remote)
              openExternal(branchWebUrl(remote.url, branch, gitProvider))
          })
        }
      })
      .catch(() => {
        win?.close()
        toast.error('Failed to fetch remotes')
      })
  }, [forgeLabels.name, gitProvider, worktree?.branch, worktree?.path])

  const openPrByNumber = useCallback(
    (number: number) => {
      const targetPath = worktree?.path
      if (!targetPath) return
      const win = preOpenWindow()
      invoke<GitHubRemote[]>('get_github_remotes', { repoPath: targetPath })
        .then(remotes => {
          if (!remotes || remotes.length <= 1) {
            const url = remotes?.[0]?.url
            if (url)
              openExternal(pullRequestWebUrl(url, number, gitProvider), win)
            else win?.close()
          } else {
            win?.close()
            useUIStore.getState().openRemotePicker(targetPath, remoteName => {
              const remote = remotes.find(r => r.name === remoteName)
              if (remote)
                openExternal(pullRequestWebUrl(remote.url, number, gitProvider))
            })
          }
        })
        .catch(() => {
          win?.close()
          toast.error('Failed to fetch remotes')
        })
    },
    [gitProvider, worktree?.path]
  )

  const hasLinkedPr = !!(prUrl && prNumber) || !!stackedOnPR
  const repoUrl = (owner: string, name: string) =>
    hostedRepoWebUrl(forgeHost, owner, name)
  const contextGroups: MobileContextGroup[] = [
    {
      title: 'Issues',
      items: loadedIssueContexts.map(ctx => ({
        key: String(ctx.number),
        icon: <CircleDot className="h-4 w-4 shrink-0 text-success" />,
        label: `#${ctx.number} ${ctx.title}`,
        onView: () => handleViewIssue(ctx),
        externalUrl: issueWebUrl(
          repoUrl(ctx.repoOwner, ctx.repoName),
          ctx.number,
          gitProvider
        ),
      })),
    },
    {
      title: `${forgeLabels.pullRequest}s`,
      items: loadedPRContexts.map(ctx => ({
        key: String(ctx.number),
        icon: <GitPullRequest className="h-4 w-4 shrink-0 text-success" />,
        label: `#${ctx.number} ${ctx.title}`,
        onView: () => handleViewPR(ctx),
        externalUrl: pullRequestWebUrl(
          repoUrl(ctx.repoOwner, ctx.repoName),
          ctx.number,
          gitProvider
        ),
      })),
    },
    {
      title: 'Discussions',
      items: loadedDiscussionContexts.map(ctx => ({
        key: String(ctx.number),
        icon: <MessagesSquare className="h-4 w-4 shrink-0 text-success" />,
        label: `#${ctx.number} ${ctx.title}`,
        onView: () => handleViewDiscussion(ctx),
        externalUrl: `https://github.com/${ctx.repoOwner}/${ctx.repoName}/discussions/${ctx.number}`,
      })),
    },
    {
      title: 'Security Alerts',
      items: loadedSecurityContexts.map(ctx => ({
        key: String(ctx.number),
        icon: <Shield className="h-4 w-4 shrink-0 text-warning" />,
        label: `#${ctx.number} ${ctx.packageName} (${ctx.severity})`,
        onView: () => handleViewSecurityAlert(ctx),
        externalUrl: `https://github.com/${ctx.repoOwner}/${ctx.repoName}/security/dependabot/${ctx.number}`,
      })),
    },
    {
      title: 'Advisories',
      items: loadedAdvisoryContexts.map(ctx => ({
        key: ctx.ghsaId,
        icon: <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />,
        label: `${ctx.ghsaId} — ${ctx.summary}`,
        onView: () => handleViewAdvisory(ctx),
        externalUrl: `https://github.com/${ctx.repoOwner}/${ctx.repoName}/security/advisories/${ctx.ghsaId}`,
      })),
    },
    {
      title: 'Linear Issues',
      items: loadedLinearContexts.map(ctx => ({
        key: ctx.identifier,
        icon: (
          <LinearIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        ),
        label: `${ctx.identifier} ${ctx.title}`,
        onView: () => handleViewLinear(ctx),
        externalUrl: ctx.url,
      })),
    },
    {
      title: 'Sentry Issues',
      items: loadedSentryContexts.map(ctx => ({
        key: ctx.id,
        icon: <Sentry className="h-4 w-4 shrink-0 text-warning" />,
        label: `${ctx.shortId} ${ctx.title}`,
        onView: () => handleViewSentry(ctx),
        externalUrl: ctx.permalink,
      })),
    },
    {
      title: 'Saved contexts',
      items: attachedSavedContexts.map(ctx => ({
        key: ctx.slug,
        icon: <FolderOpen className="h-4 w-4 shrink-0 text-info" />,
        label: ctx.name || ctx.slug,
        onView: () => handleViewSavedContext(ctx),
      })),
    },
  ].filter(group => group.items.length > 0)
  const contextCount = contextGroups.reduce(
    (count, group) => count + group.items.length,
    0
  )
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
          {showProviderMenu && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Sparkles className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>Provider</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {providerDisplayName}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {showClaudeProviders ? (
                  <DropdownMenuRadioGroup
                    value={selectedProvider ?? '__anthropic__'}
                    onValueChange={handleProviderChange}
                  >
                    <DropdownMenuRadioItem
                      value="__anthropic__"
                      onSelect={keepMenuOpenOnSelect}
                    >
                      Anthropic
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Custom Providers
                    </DropdownMenuLabel>
                    {customCliProfiles.map(profile => (
                      <DropdownMenuRadioItem
                        key={profile.name}
                        value={profile.name}
                        onSelect={keepMenuOpenOnSelect}
                      >
                        {profile.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                ) : (
                  <DropdownMenuRadioGroup
                    value={selectedProvider ?? '__default__'}
                    onValueChange={handleProviderChange}
                  >
                    <DropdownMenuRadioItem
                      value="__default__"
                      onSelect={keepMenuOpenOnSelect}
                    >
                      Default (OpenAI)
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Custom Providers
                    </DropdownMenuLabel>
                    {customCodexProviders.map(profile => (
                      <DropdownMenuRadioItem
                        key={profile.name}
                        value={profile.name}
                        onSelect={keepMenuOpenOnSelect}
                      >
                        {profile.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {!hideModelPicker && (
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
          )}

          {hideReasoningControl ? null : usesEffortControl && isMobile ? (
            <DropdownMenuItem onSelect={openReasoningPicker}>
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
                      onSelect={keepMenuOpenOnSelect}
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
          ) : isMobile ? (
            <DropdownMenuItem onSelect={openReasoningPicker}>
              <Brain className="h-4 w-4 text-muted-foreground" />
              <span>Thinking</span>
              <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                {displayedThinkingLabel}
              </span>
              <ChevronRight className="ml-2 h-4 w-4 shrink-0 text-foreground" />
            </DropdownMenuItem>
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
                      onSelect={keepMenuOpenOnSelect}
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
                  activeMcpCount > 0 ? 'text-success' : 'text-muted-foreground'
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
                      ? 'text-success'
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
                          <DropdownMenuLabel className="py-1 text-xs font-medium text-muted-foreground">
                            <BackendLabel
                              backend={backend}
                              badgeClassName="text-2xs leading-3"
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
                              !server.disabled && enabledMcpServersSet.has(key)
                            }
                            onCheckedChange={() => onToggleMcpServer(key)}
                            onSelect={keepMenuOpenOnSelect}
                            disabled={
                              server.disabled || isAutoLoadedMcpBackend(backend)
                            }
                            className={
                              server.disabled ? 'opacity-50' : undefined
                            }
                          >
                            {server.name}
                            <span className="ml-auto pl-4 text-xs text-muted-foreground">
                              {server.disabled
                                ? 'disabled'
                                : isAutoLoadedMcpBackend(backend)
                                  ? 'automatic'
                                  : server.scope}
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
          {contextCount > 0 && (
            <DropdownMenuItem onSelect={openContextsSheet}>
              <FolderOpen className="h-4 w-4" />
              <span>Contexts ({contextCount})</span>
              <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-foreground" />
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
                    {runScripts.map(cmd => (
                      <DropdownMenuItem
                        key={cmd}
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
              <TerminalActivityIcon
                active={hasActiveTerminal}
                className="h-4 w-4"
              />
              Terminal
              {hasActiveTerminal && <span className="sr-only"> active</span>}
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
                  {gitProvider === 'gitlab' ? (
                    <GitLabIcon className="h-4 w-4" />
                  ) : (
                    <Github className="h-4 w-4" />
                  )}
                  {forgeLabels.name}
                  <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
                </DropdownMenuItem>
              )}
              {ports.map(port => {
                const host = resolvePortHost(port, serverDefaultHost)
                const url = resolvePortUrl(port, serverDefaultHost)
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
                    Stacked on #{stackedOnPR.number}
                    {stackedOnPR.title ? ` ${stackedOnPR.title}` : ''}
                  </span>
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet open={effortSheetOpen} onOpenChange={setReasoningSheetOpen}>
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
                    setReasoningSheetOpen(false)
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

      <Sheet open={thinkingSheetOpen} onOpenChange={setReasoningSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[75svh] overflow-hidden rounded-t-xl p-0"
          showCloseButton={false}
        >
          <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
            <SheetTitle>Select thinking</SheetTitle>
            <SheetDescription>
              Choose how much thinking the model should use.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            {thinkingLevelOptions.map(option => {
              const selected = option.value === displayedThinkingLevel
              const detail =
                'tokens' in option ? option.tokens : option.description
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
                    handleThinkingLevelChange(option.value)
                    setReasoningSheetOpen(false)
                  }}
                >
                  <span className="flex-1">
                    <span className="block font-medium">{option.label}</span>
                    {detail ? (
                      <span className="block text-xs text-muted-foreground">
                        {detail}
                      </span>
                    ) : null}
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
                        'fill-warning text-warning'
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
                      !server.disabled && enabledMcpServersSet.has(key)
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={
                          server.disabled || isAutoLoadedMcpBackend(backend)
                        }
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
                          {isAutoLoadedMcpBackend(backend) &&
                            !server.disabled && (
                              <span className="block text-xs text-muted-foreground">
                                Loaded automatically by{' '}
                                {getBackendLabel(backend)}
                              </span>
                            )}
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

      <MobileContextsSheet
        open={contextsSheetOpen}
        onOpenChange={setContextsSheetOpen}
        groups={contextGroups}
      />
    </>
  )
}
