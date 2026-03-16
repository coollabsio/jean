import {
  Brain,
  ChevronDown,
  CircleDot,
  ClipboardList,
  ExternalLink,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  Hammer,
  Loader2,
  Plug,
  Shield,
  ShieldAlert,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CustomCliProfile } from '@/types/preferences'
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
import { CheckStatusButton } from '@/components/chat/toolbar/CheckStatusButton'
import {
  McpStatusDot,
  mcpStatusHint,
} from '@/components/chat/toolbar/McpStatusDot'
import { groupServersByBackend, BACKEND_LABELS } from '@/services/mcp'
import type { CliBackend } from '@/types/preferences'
import {
  EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  getPrStatusDisplay,
  getProviderDisplayName,
} from '@/components/chat/toolbar/toolbar-utils'

interface DesktopToolbarControlsProps {
  hasPendingQuestions: boolean
  selectedBackend: 'claude' | 'codex' | 'opencode'
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
  filteredModelOptions: { value: string; label: string }[]
  selectedModelLabel: string
  isCodex: boolean

  prUrl: string | undefined
  prNumber: number | undefined
  displayStatus: PrDisplayStatus | undefined
  checkStatus: CheckStatus | undefined
  mergeableStatus: MergeableStatus | undefined
  activeWorktreePath: string | undefined

  availableMcpServers: McpServerInfo[]
  enabledMcpServers: string[]
  activeMcpCount: number
  isHealthChecking: boolean
  mcpStatuses: Record<string, McpHealthStatus> | undefined

  loadedIssueContexts: LoadedIssueContext[]
  loadedPRContexts: LoadedPullRequestContext[]
  loadedSecurityContexts: LoadedSecurityAlertContext[]
  loadedAdvisoryContexts: LoadedAdvisoryContext[]
  loadedLinearContexts: LoadedLinearIssueContext[]
  attachedSavedContexts: AttachedSavedContext[]

  providerDropdownOpen: boolean
  modelDropdownOpen: boolean
  thinkingDropdownOpen: boolean
  mcpDropdownOpen: boolean
  setProviderDropdownOpen: (open: boolean) => void
  setModelDropdownOpen: (open: boolean) => void
  setThinkingDropdownOpen: (open: boolean) => void
  onMcpDropdownOpenChange: (open: boolean) => void

  onOpenMagicModal: () => void
  onOpenProjectSettings?: () => void
  onResolvePrConflicts: () => void
  onLoadContext: () => void
  installedBackends: ('claude' | 'codex' | 'opencode')[]
  onBackendChange: (backend: 'claude' | 'codex' | 'opencode') => void
  onSetExecutionMode: (mode: ExecutionMode) => void
  onToggleMcpServer: (name: string) => void

  handleModelChange: (value: string) => void
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
  filteredModelOptions,
  selectedModelLabel,
  isCodex,
  prUrl,
  prNumber,
  displayStatus,
  checkStatus,
  mergeableStatus,
  activeWorktreePath,
  availableMcpServers,
  enabledMcpServers,
  activeMcpCount,
  isHealthChecking,
  mcpStatuses,
  loadedIssueContexts,
  loadedPRContexts,
  loadedSecurityContexts,
  loadedAdvisoryContexts,
  loadedLinearContexts,
  attachedSavedContexts,
  providerDropdownOpen,
  modelDropdownOpen,
  thinkingDropdownOpen,
  mcpDropdownOpen,
  setProviderDropdownOpen,
  setModelDropdownOpen,
  setThinkingDropdownOpen,
  onMcpDropdownOpenChange,
  onOpenMagicModal,
  onOpenProjectSettings,
  onResolvePrConflicts,
  onLoadContext,
  installedBackends,
  onBackendChange,
  onSetExecutionMode,
  onToggleMcpServer,
  handleModelChange,
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
  // Prevent Radix from restoring focus to the trigger button;
  // redirect focus to the chat input instead.
  const focusChatInput = useCallback((e: Event) => {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('focus-chat-input'))
  }, [])

  const loadedIssueCount = loadedIssueContexts.length
  const loadedPRCount = loadedPRContexts.length
  const loadedSecurityCount = loadedSecurityContexts.length + loadedAdvisoryContexts.length
  const loadedLinearCount = loadedLinearContexts.length
  const loadedContextCount = attachedSavedContexts.length
  const providerDisplayName = getProviderDisplayName(selectedProvider)
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const modelSearchInputRef = useRef<HTMLInputElement>(null)
  const visibleModelOptions = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase()
    if (!query) return filteredModelOptions
    return filteredModelOptions.filter(
      option =>
        option.label.toLowerCase().includes(query) ||
        option.value.toLowerCase().includes(query)
    )
  }, [filteredModelOptions, modelSearchQuery])

  useEffect(() => {
    if (!modelDropdownOpen) return
    requestAnimationFrame(() => {
      modelSearchInputRef.current?.focus()
      modelSearchInputRef.current?.select()
    })
  }, [modelDropdownOpen])

  return (
    <>
      <div className="block @xl:hidden h-4 w-px bg-border/50" />

      <button
        type="button"
        className="hidden @xl:flex h-8 items-center gap-1 rounded-l-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        disabled={hasPendingQuestions}
        onClick={onOpenMagicModal}
      >
        <Wand2 className="h-3.5 w-3.5" />
      </button>

      <div className="hidden @xl:block h-4 w-px bg-border/50" />

      <DropdownMenu
        open={mcpDropdownOpen}
        onOpenChange={onMcpDropdownOpenChange}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={hasPendingQuestions}
                className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <Plug
                  className={cn(
                    'h-3.5 w-3.5',
                    activeMcpCount > 0 &&
                      'text-emerald-600 dark:text-emerald-400'
                  )}
                />
                {activeMcpCount > 0 && <span>{activeMcpCount}</span>}
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {activeMcpCount > 0
              ? `${activeMcpCount} MCP server(s) enabled`
              : 'No MCP servers enabled'}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="flex items-center gap-2">
            MCP Servers
            {isHealthChecking && (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {availableMcpServers.length > 0 ? (
            (() => {
              const grouped = groupServersByBackend(availableMcpServers)
              const backends = Object.keys(grouped) as CliBackend[]
              const showHeaders = backends.length > 1
              return backends.map((backend, idx) => (
                <div key={backend}>
                  {showHeaders && (
                    <>
                      {idx > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium py-1">
                        {BACKEND_LABELS[backend] ?? backend}
                      </DropdownMenuLabel>
                    </>
                  )}
                  {(grouped[backend] ?? []).map(server => {
                    const status = mcpStatuses?.[server.name]
                    const hint = mcpStatusHint(status)
                    const item = (
                      <DropdownMenuCheckboxItem
                        key={`${backend}-${server.name}`}
                        checked={
                          !server.disabled && enabledMcpServers.includes(server.name)
                        }
                        onCheckedChange={() => onToggleMcpServer(server.name)}
                        disabled={server.disabled}
                        className={server.disabled ? 'opacity-50' : undefined}
                      >
                        <span className="flex items-center gap-1.5">
                          <McpStatusDot status={status} />
                          {server.name}
                        </span>
                        <span className="ml-auto pl-4 text-xs text-muted-foreground">
                          {server.disabled ? 'disabled' : server.scope}
                        </span>
                      </DropdownMenuCheckboxItem>
                    )
                    if (!hint) return item
                    return (
                      <Tooltip key={`${backend}-${server.name}`}>
                        <TooltipTrigger asChild>{item}</TooltipTrigger>
                        <TooltipContent side="left">{hint}</TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              ))
            })()
          ) : (
            <DropdownMenuItem disabled>
              <span className="text-xs text-muted-foreground">
                No MCP servers configured
              </span>
            </DropdownMenuItem>
          )}
          {onOpenProjectSettings && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onOpenProjectSettings}>
                <span className="text-xs text-muted-foreground">
                  Set defaults in project settings
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
                    loadedIssueCount > 0 && `${loadedIssueCount} Issue${loadedIssueCount > 1 ? 's' : ''}`,
                    loadedPRCount > 0 && `${loadedPRCount} PR${loadedPRCount > 1 ? 's' : ''}`,
                    loadedSecurityCount > 0 && `${loadedSecurityCount} Security`,
                    loadedLinearCount > 0 && `${loadedLinearCount} Linear`,
                    loadedContextCount > 0 && `${loadedContextCount} Context${loadedContextCount > 1 ? 's' : ''}`,
                  ].filter(Boolean).join(', ')}
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
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
                    loadedSecurityContexts.length > 0) && <DropdownMenuSeparator />}
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
                    loadedAdvisoryContexts.length > 0) && <DropdownMenuSeparator />}
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
                    loadedLinearContexts.length > 0) && <DropdownMenuSeparator />}
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
                <CheckStatusButton
                  status={checkStatus ?? null}
                  projectPath={activeWorktreePath}
                />
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

      {!sessionHasMessages && (
        <>
          <div className="hidden @xl:block h-4 w-px bg-border/50" />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={hasPendingQuestions}
                    className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span>
                      {selectedBackend === 'claude'
                        ? 'Claude'
                        : selectedBackend === 'codex'
                          ? 'Codex'
                          : 'OpenCode'}
                    </span>
                    {(selectedBackend === 'codex' ||
                      selectedBackend === 'opencode') && (
                      <span className="rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                        BETA
                      </span>
                    )}
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Switch backend (Tab)</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="min-w-40" onCloseAutoFocus={focusChatInput}>
              <DropdownMenuRadioGroup
                value={selectedBackend}
                onValueChange={v =>
                  onBackendChange(v as 'claude' | 'codex' | 'opencode')
                }
              >
                {installedBackends.includes('claude') && (
                  <DropdownMenuRadioItem value="claude">
                    Claude
                  </DropdownMenuRadioItem>
                )}
                {installedBackends.includes('codex') && (
                  <DropdownMenuRadioItem value="codex">
                    Codex
                    <span className="ml-auto rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                      BETA
                    </span>
                  </DropdownMenuRadioItem>
                )}
                {installedBackends.includes('opencode') && (
                  <DropdownMenuRadioItem value="opencode">
                    OpenCode
                    <span className="ml-auto rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                      BETA
                    </span>
                  </DropdownMenuRadioItem>
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {customCliProfiles.length > 0 &&
        !providerLocked &&
        selectedBackend === 'claude' && (
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
                      disabled={hasPendingQuestions}
                      className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    >
                      <span>{providerDisplayName}</span>
                      <ChevronDown className="h-3 w-3 opacity-50" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Provider (⌘⇧P)</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="min-w-40" onEscapeKeyDown={e => e.stopPropagation()} onCloseAutoFocus={focusChatInput}>
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

      <DropdownMenu
        open={modelDropdownOpen}
        onOpenChange={open => {
          setModelDropdownOpen(open)
          if (!open) {
            setModelSearchQuery('')
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={hasPendingQuestions}
                className="hidden @xl:flex h-8 min-w-0 items-center gap-1.5 rounded-none bg-transparent px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-48 truncate">{selectedModelLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Model (⌘⇧M)</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="min-w-40"
          enableNumberSelection={false}
          onEscapeKeyDown={e => e.stopPropagation()}
          onCloseAutoFocus={focusChatInput}
        >
          {providerLocked && customCliProfiles.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Provider: {providerDisplayName}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          <div className="p-1">
            <Input
              ref={modelSearchInputRef}
              value={modelSearchQuery}
              onChange={event => setModelSearchQuery(event.target.value)}
              onKeyDown={event => {
                const items = event.currentTarget
                  .closest('[role="menu"]')
                  ?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
                if (event.key === 'ArrowDown' || event.key === 'Tab') {
                  event.preventDefault()
                  event.stopPropagation()
                  items?.[0]?.focus()
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  event.stopPropagation()
                  items?.[items.length - 1]?.focus()
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                  if (visibleModelOptions.length > 0) {
                    handleModelChange(visibleModelOptions[0]!.value)
                  }
                } else {
                  event.stopPropagation()
                }
              }}
              placeholder="Search models..."
              className="h-8 text-xs"
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            className="max-h-[19rem] overflow-y-auto"
            value={selectedModel}
            onValueChange={handleModelChange}
          >
            {visibleModelOptions.length > 0 ? (
              visibleModelOptions.map(option => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))
            ) : (
              <DropdownMenuItem disabled>No models found</DropdownMenuItem>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {!hideThinkingLevel && (
        <div className="hidden @xl:block h-4 w-px bg-border/50" />
      )}

      {hideThinkingLevel ? null : useAdaptiveThinking || isCodex ? (
        <DropdownMenu
          open={thinkingDropdownOpen}
          onOpenChange={setThinkingDropdownOpen}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={hasPendingQuestions}
                  className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Brain className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                  <span>
                    {
                      EFFORT_LEVEL_OPTIONS.find(
                        o => o.value === selectedEffortLevel
                      )?.label
                    }
                  </span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {`Effort: ${EFFORT_LEVEL_OPTIONS.find(o => o.value === selectedEffortLevel)?.label} (⌘⇧E)`}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" onEscapeKeyDown={e => e.stopPropagation()} onCloseAutoFocus={focusChatInput}>
            <DropdownMenuRadioGroup
              value={selectedEffortLevel}
              onValueChange={handleEffortLevelChange}
            >
              {EFFORT_LEVEL_OPTIONS.map((option, i) => (
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
                  disabled={hasPendingQuestions}
                  className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Brain
                    className={cn(
                      'h-3.5 w-3.5',
                      selectedThinkingLevel !== 'off' &&
                        'text-purple-600 dark:text-purple-400'
                    )}
                  />
                  <span>
                    {
                      THINKING_LEVEL_OPTIONS.find(
                        o => o.value === selectedThinkingLevel
                      )?.label
                    }
                  </span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {`Thinking: ${THINKING_LEVEL_OPTIONS.find(o => o.value === selectedThinkingLevel)?.label} (⌘⇧E)`}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" onEscapeKeyDown={e => e.stopPropagation()} onCloseAutoFocus={focusChatInput}>
            <DropdownMenuRadioGroup
              value={selectedThinkingLevel}
              onValueChange={handleThinkingLevelChange}
            >
              {THINKING_LEVEL_OPTIONS.map((option, i) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <Brain className="mr-2 h-4 w-4" />
                  {option.label}
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">
                    {option.tokens}
                  </span>
                  <Kbd className="ml-2 text-[10px]">{i + 1}</Kbd>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="hidden @xl:block h-4 w-px bg-border/50" />

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={hasPendingQuestions}
                className="hidden @xl:flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                {executionMode === 'plan' && (
                  <ClipboardList className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />
                )}
                {executionMode === 'build' && (
                  <Hammer className="h-3.5 w-3.5" />
                )}
                {executionMode === 'yolo' && (
                  <Zap className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
                )}
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {`${executionMode.charAt(0).toUpperCase() + executionMode.slice(1)} mode (Shift+Tab to cycle)`}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" onCloseAutoFocus={focusChatInput}>
          <DropdownMenuRadioGroup
            value={executionMode}
            onValueChange={v => onSetExecutionMode(v as ExecutionMode)}
          >
            <DropdownMenuRadioItem value="plan">
              <ClipboardList className="mr-2 h-4 w-4" />
              Plan
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                Read-only
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="build">
              <Hammer className="mr-2 h-4 w-4" />
              Build
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                Auto-edits
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioItem
              value="yolo"
              className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
            >
              <Zap className="mr-2 h-4 w-4" />
              Yolo
              <span className="ml-auto pl-4 text-xs">No limits!</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
