import {
  Brain,
  CircleDot,
  ExternalLink,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  Paperclip,
  Shield,
  ShieldAlert,
  Wand2,
} from 'lucide-react'
import { useCallback } from 'react'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CliBackend, CustomCliProfile } from '@/types/preferences'
import type {
  EffortLevel,
  ExecutionMode,
  McpHealthStatus,
  McpServerInfo,
  ThinkingLevel,
} from '@/types/chat'
import type {
  AttachedSavedContext,
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
} from '@/types/github'
import type { LoadedLinearIssueContext } from '@/types/linear'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type {
  CheckStatus,
  MergeableStatus,
  PrDisplayStatus,
} from '@/types/pr-status'
import { openExternal } from '@/lib/platform'
import { cn } from '@/lib/utils'
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
import { DesktopBackendModelPicker } from '@/components/chat/toolbar/DesktopBackendModelPicker'
import { ExecutionModeDropdown } from '@/components/chat/toolbar/ExecutionModeDropdown'
import { DockBurgerButton } from '@/components/chat/toolbar/DockBurgerButton'
import type { ModelReasoningCapability } from '@/services/model-catalog'

interface DesktopToolbarControlsProps {
  hasPendingQuestions: boolean
  selectedBackend: CliBackend
  selectedModel: string
  selectedProvider: string | null
  selectedThinkingLevel: ThinkingLevel
  selectedEffortLevel: EffortLevel
  executionMode: ExecutionMode
  useAdaptiveThinking: boolean
  hideThinkingLevel?: boolean
  sessionHasMessages?: boolean
  providerLocked?: boolean
  customCliProfiles: CustomCliProfile[]
  isCodex: boolean
  modelReasoning?: ModelReasoningCapability | null

  prUrl: string | undefined
  prNumber: number | undefined
  displayStatus: PrDisplayStatus | undefined
  checkStatus: CheckStatus | undefined
  mergeableStatus: MergeableStatus | undefined
  activeWorktreePath: string | undefined

  availableMcpServers: McpServerInfo[]
  enabledMcpServers: string[]
  isHealthChecking: boolean
  mcpStatuses: Record<string, McpHealthStatus> | undefined

  loadedIssueContexts: LoadedIssueContext[]
  loadedPRContexts: LoadedPullRequestContext[]
  loadedSecurityContexts: LoadedSecurityAlertContext[]
  loadedAdvisoryContexts: LoadedAdvisoryContext[]
  loadedLinearContexts: LoadedLinearIssueContext[]
  attachedSavedContexts: AttachedSavedContext[]

  providerDropdownOpen: boolean
  thinkingDropdownOpen: boolean
  mcpDropdownOpen: boolean
  setProviderDropdownOpen: (open: boolean) => void
  setThinkingDropdownOpen: (open: boolean) => void
  onMcpDropdownOpenChange: (open: boolean) => void

  onOpenMagicModal: () => void
  onOpenProjectSettings?: () => void
  onResolvePrConflicts: () => void
  onLoadContext: () => void
  onAttach: () => void
  installedBackends: CliBackend[]
  onSetExecutionMode: (mode: ExecutionMode) => void
  availableExecutionModes: ExecutionMode[]
  onToggleMcpServer: (name: string) => void

  handleModelChange: (value: string) => void
  handleBackendModelChange: (backend: CliBackend, model: string) => void
  handleProviderChange: (value: string) => void
  handleThinkingLevelChange: (value: string) => void
  handleEffortLevelChange: (value: string) => void
  handleViewIssue: (ctx: LoadedIssueContext) => void
  handleViewPR: (ctx: LoadedPullRequestContext) => void
  handleViewSecurityAlert: (ctx: LoadedSecurityAlertContext) => void
  handleViewAdvisory: (ctx: LoadedAdvisoryContext) => void
  handleViewLinear: (ctx: LoadedLinearIssueContext) => void
  handleViewSavedContext: (ctx: AttachedSavedContext) => void
}

export function DesktopToolbarControls({
  hasPendingQuestions,
  selectedBackend,
  selectedModel,
  selectedProvider,
  selectedThinkingLevel,
  selectedEffortLevel,
  executionMode,
  useAdaptiveThinking,
  hideThinkingLevel,
  sessionHasMessages,
  providerLocked,
  customCliProfiles,
  isCodex,
  modelReasoning,
  prUrl,
  prNumber,
  displayStatus,
  checkStatus: _checkStatus,
  mergeableStatus,
  activeWorktreePath: _activeWorktreePath,
  availableMcpServers: _availableMcpServers,
  enabledMcpServers: _enabledMcpServers,
  isHealthChecking: _isHealthChecking,
  mcpStatuses: _mcpStatuses,
  loadedIssueContexts,
  loadedPRContexts,
  loadedSecurityContexts,
  loadedAdvisoryContexts,
  loadedLinearContexts,
  attachedSavedContexts,
  providerDropdownOpen,
  thinkingDropdownOpen,
  mcpDropdownOpen: _mcpDropdownOpen,
  setProviderDropdownOpen,
  setThinkingDropdownOpen,
  onMcpDropdownOpenChange: _onMcpDropdownOpenChange,
  onOpenMagicModal,
  onOpenProjectSettings: _onOpenProjectSettings,
  onResolvePrConflicts,
  onLoadContext,
  onAttach,
  installedBackends,
  onSetExecutionMode,
  availableExecutionModes,
  onToggleMcpServer: _onToggleMcpServer,
  handleModelChange,
  handleBackendModelChange,
  handleProviderChange,
  handleThinkingLevelChange,
  handleEffortLevelChange,
  handleViewIssue,
  handleViewPR,
  handleViewSecurityAlert,
  handleViewAdvisory,
  handleViewLinear,
  handleViewSavedContext,
}: DesktopToolbarControlsProps) {
  const isPi = selectedBackend === 'pi'
  const isGrok = selectedBackend === 'grok'
  const isKimi = selectedBackend === 'kimi'
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

  // Prevent Radix from restoring focus to the trigger button;
  // redirect focus to the chat input instead.
  const focusChatInput = useCallback((e: Event) => {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('focus-chat-input'))
  }, [])

  const loadedIssueCount = loadedIssueContexts.length
  const loadedPRCount = loadedPRContexts.length
  const loadedSecurityCount =
    loadedSecurityContexts.length + loadedAdvisoryContexts.length
  const loadedLinearCount = loadedLinearContexts.length
  const loadedContextCount = attachedSavedContexts.length
  const providerDisplayName = getProviderDisplayName(selectedProvider)

  return (
    <>
      <DockBurgerButton className="hidden @xl:flex" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Magic"
            className="hidden @xl:flex h-8 items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onOpenMagicModal}
          >
            <Wand2 className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Magic (⌘M)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Attachments"
            disabled={hasPendingQuestions}
            className="hidden @xl:flex h-8 items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onAttach}
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Attachments</TooltipContent>
      </Tooltip>

      <div className="hidden @xl:block h-4 w-px bg-border/50" />

      {(loadedIssueCount > 0 ||
        loadedPRCount > 0 ||
        loadedSecurityCount > 0 ||
        loadedLinearCount > 0 ||
        loadedContextCount > 0) && (
        <>
          <div className="hidden @xl:block h-4 w-px bg-border/50" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
              >
                <CircleDot className="h-3.5 w-3.5" />
                <span>
                  {[
                    loadedIssueCount > 0 && `${loadedIssueCount}`,
                    loadedPRCount > 0 && `${loadedPRCount}`,
                    loadedSecurityCount > 0 && `${loadedSecurityCount}`,
                    loadedLinearCount > 0 && `${loadedLinearCount}`,
                    loadedContextCount > 0 && `${loadedContextCount}`,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {loadedIssueContexts.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Issues
                  </DropdownMenuLabel>
                  {loadedIssueContexts.map(ctx => (
                    <DropdownMenuItem
                      key={ctx.number}
                      onClick={() => handleViewIssue(ctx)}
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
                      onClick={() => handleViewPR(ctx)}
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
                      onClick={() => handleViewSecurityAlert(ctx)}
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
                      onClick={() => handleViewAdvisory(ctx)}
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
                      onClick={() => handleViewLinear(ctx)}
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
                      onClick={() => handleViewSavedContext(ctx)}
                    >
                      <FolderOpen className="h-4 w-4 text-blue-500" />
                      <span className="truncate">{ctx.name || ctx.slug}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onLoadContext}>
                <FolderOpen className="h-4 w-4" />
                Manage Contexts...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {prUrl && prNumber && (
        <>
          <div className="hidden @xl:block h-4 w-px bg-border/50" />
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors select-none hover:bg-muted/80 hover:text-foreground',
                  displayStatus
                    ? getPrStatusDisplay(displayStatus).className
                    : 'text-muted-foreground'
                )}
              >
                {displayStatus === 'merged' ? (
                  <GitMerge className="h-3.5 w-3.5" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5" />
                )}
                <span>#{prNumber}</span>
              </a>
            </TooltipTrigger>
            <TooltipContent>
              {displayStatus
                ? `${getPrStatusDisplay(displayStatus).label} · PR #${prNumber} on GitHub`
                : `PR #${prNumber} on GitHub`}
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {mergeableStatus === 'conflicting' && (
        <>
          <div className="hidden @xl:block h-4 w-px bg-border/50" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-amber-600 dark:text-amber-400 transition-colors cursor-pointer hover:bg-muted/80"
                onClick={onResolvePrConflicts}
              >
                <GitMerge className="h-3 w-3" />
                <span>Conflicts</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              PR has merge conflicts — click to resolve
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {customCliProfiles.length > 0 && selectedBackend === 'claude' && (
        <>
          <div className="hidden @xl:block h-4 w-px bg-border/50" />
          <DropdownMenu
            open={providerDropdownOpen}
            onOpenChange={setProviderDropdownOpen}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span>{providerDisplayName}</span>
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Provider (⌘⇧P)</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              className="min-w-40"
              onEscapeKeyDown={e => e.stopPropagation()}
              onCloseAutoFocus={focusChatInput}
            >
              <DropdownMenuRadioGroup
                value={selectedProvider ?? '__anthropic__'}
                onValueChange={handleProviderChange}
              >
                <DropdownMenuRadioItem value="__anthropic__">
                  Anthropic
                  <Kbd className="ml-auto text-[10px]">1</Kbd>
                </DropdownMenuRadioItem>
                {customCliProfiles.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Custom Providers
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none">
                        cc
                      </span>
                    </DropdownMenuLabel>
                    {customCliProfiles.map((profile, i) => (
                      <DropdownMenuRadioItem
                        key={profile.name}
                        value={profile.name}
                      >
                        {profile.name}
                        <Kbd className="ml-auto text-[10px]">{i + 2}</Kbd>
                      </DropdownMenuRadioItem>
                    ))}
                  </>
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      <div className="hidden @xl:block h-4 w-px bg-border/50" />

      <DesktopBackendModelPicker
        disabled={false}
        sessionHasMessages={sessionHasMessages}
        providerLocked={providerLocked}
        triggerClassName="rounded-none border-0 bg-transparent px-3"
        selectedBackend={selectedBackend}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
        installedBackends={installedBackends}
        customCliProfiles={customCliProfiles}
        onModelChange={handleModelChange}
        onBackendModelChange={handleBackendModelChange}
      />

      {!hideReasoningControl && (
        <div className="hidden @xl:block h-4 w-px bg-border/50" />
      )}

      {hideReasoningControl ? null : usesEffortControl ? (
        <DropdownMenu
          open={thinkingDropdownOpen}
          onOpenChange={setThinkingDropdownOpen}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Brain className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                  <span>{displayedEffortLabel}</span>
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {`Effort: ${displayedEffortLabel} (⌘⇧E)`}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            onEscapeKeyDown={e => e.stopPropagation()}
            onCloseAutoFocus={focusChatInput}
          >
            <DropdownMenuRadioGroup
              value={displayedEffortLevel}
              onValueChange={handleEffortLevelChange}
            >
              {effortLevelOptions.map((option, i) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <Brain className="mr-2 h-4 w-4" />
                  {option.label}
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">
                    {option.description}
                  </span>
                  <Kbd className="ml-2 text-[10px]">{i + 1}</Kbd>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <DropdownMenu
          open={thinkingDropdownOpen}
          onOpenChange={setThinkingDropdownOpen}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Brain
                    className={cn(
                      'h-3.5 w-3.5',
                      displayedThinkingLevel !== 'off' &&
                        'text-purple-600 dark:text-purple-400'
                    )}
                  />
                  <span>{displayedThinkingLabel}</span>
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {`Thinking: ${displayedThinkingLabel} (⌘⇧E)`}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            onEscapeKeyDown={e => e.stopPropagation()}
            onCloseAutoFocus={focusChatInput}
          >
            <DropdownMenuRadioGroup
              value={displayedThinkingLevel}
              onValueChange={handleThinkingLevelChange}
            >
              {thinkingLevelOptions.map((option, i) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <Brain className="mr-2 h-4 w-4" />
                  {option.label}
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">
                    {'tokens' in option ? option.tokens : option.description}
                  </span>
                  <Kbd className="ml-2 text-[10px]">{i + 1}</Kbd>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="hidden @xl:block h-4 w-px bg-border/50" />

      <ExecutionModeDropdown
        executionMode={executionMode}
        availableModes={availableExecutionModes}
        disabled={false}
        onSetExecutionMode={onSetExecutionMode}
        className="hidden @xl:flex"
        onCloseAutoFocus={focusChatInput}
      />
    </>
  )
}
