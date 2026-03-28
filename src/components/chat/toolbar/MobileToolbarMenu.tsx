import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bot,
  BookmarkPlus,
  Brain,
  Bug,
  Check,
  ChevronRight,
  CircleDot,
  ClipboardList,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Hammer,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plug,
  RefreshCw,
  Shield,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react'
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { CustomCliProfile, CliBackend } from '@/types/preferences'
import type {
  EffortLevel,
  ExecutionMode,
  McpServerInfo,
  ThinkingLevel,
} from '@/types/chat'
import { groupServersByBackend, BACKEND_LABELS } from '@/services/mcp'
import type {
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
  AttachedSavedContext,
} from '@/types/github'
import type { LoadedLinearIssueContext } from '@/types/linear'
import type { CheckStatus, PrDisplayStatus } from '@/types/pr-status'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { CheckStatusButton } from '@/components/chat/toolbar/CheckStatusButton'
import { openExternal } from '@/lib/platform'
import {
  EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  getPrStatusDisplay,
  getProviderDisplayName,
} from '@/components/chat/toolbar/toolbar-utils'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

interface MobileToolbarMenuProps {
  isDisabled: boolean
  hasOpenPr: boolean
  sessionHasMessages?: boolean
  providerLocked?: boolean
  selectedBackend: 'claude' | 'codex' | 'opencode'
  selectedProvider: string | null
  selectedModel: string
  selectedEffortLevel: EffortLevel
  selectedThinkingLevel: ThinkingLevel
  hideThinkingLevel?: boolean
  useAdaptiveThinking: boolean
  isCodex: boolean
  executionMode: ExecutionMode
  customCliProfiles: CustomCliProfile[]
  filteredModelOptions: { value: string; label: string }[]

  uncommittedAdded: number
  uncommittedRemoved: number
  branchDiffAdded: number
  branchDiffRemoved: number
  prUrl: string | undefined
  prNumber: number | undefined
  displayStatus: PrDisplayStatus | undefined
  checkStatus: CheckStatus | undefined
  activeWorktreePath: string | undefined

  onSaveContext: () => void
  onLoadContext: () => void
  onCommit: () => void
  onCommitAndPush: () => void
  onOpenPr: () => void
  onReview: () => void
  onMerge: () => void
  onResolveConflicts: () => void
  installedBackends: ('claude' | 'codex' | 'opencode')[]
  onBackendChange: (backend: 'claude' | 'codex' | 'opencode') => void
  onSetExecutionMode: (mode: ExecutionMode) => void

  handlePullClick: () => void
  handlePushClick: () => void
  handleUncommittedDiffClick: () => void
  handleBranchDiffClick: () => void
  handleProviderChange: (value: string) => void
  handleModelChange: (value: string) => void
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
}

export function MobileToolbarMenu({
  isDisabled,
  hasOpenPr,
  sessionHasMessages,
  providerLocked,
  selectedBackend,
  selectedProvider,
  selectedModel,
  selectedEffortLevel,
  selectedThinkingLevel,
  hideThinkingLevel,
  useAdaptiveThinking,
  isCodex,
  executionMode,
  customCliProfiles,
  filteredModelOptions,
  uncommittedAdded,
  uncommittedRemoved,
  branchDiffAdded,
  branchDiffRemoved,
  prUrl,
  prNumber,
  displayStatus,
  checkStatus,
  activeWorktreePath,
  onSaveContext,
  onLoadContext,
  onCommit,
  onCommitAndPush,
  onOpenPr,
  onReview,
  onMerge,
  onResolveConflicts,
  installedBackends,
  onBackendChange,
  onSetExecutionMode,
  handlePullClick,
  handlePushClick,
  handleUncommittedDiffClick,
  handleBranchDiffClick,
  handleProviderChange,
  handleModelChange,
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
}: MobileToolbarMenuProps) {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const providerDisplayName = getProviderDisplayName(selectedProvider)
  const selectedModelLabel = filteredModelOptions.find(
    o => o.value === selectedModel
  )?.label

  const openModelSheet = () => {
    setMenuOpen(false)
    setModelSearchQuery('')
    requestAnimationFrame(() => setModelSheetOpen(true))
  }
  const normalizedModelQuery = modelSearchQuery.trim().toLowerCase()
  const visibleModelOptions = normalizedModelQuery
    ? filteredModelOptions.filter(option => {
        const label = option.label.toLowerCase()
        const value = option.value.toLowerCase()
        return (
          label.includes(normalizedModelQuery) ||
          value.includes(normalizedModelQuery)
        )
      })
    : filteredModelOptions

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex @xl:hidden h-8 items-center gap-1 rounded-l-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={isDisabled}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={isMobile ? 'end' : 'start'}
          className="w-56"
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Context
          </div>
          <DropdownMenuItem onClick={onSaveContext}>
            <BookmarkPlus className="h-4 w-4" />
            Save Context
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              S
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onLoadContext}>
            <FolderOpen className="h-4 w-4" />
            Load Context
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              L
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setMenuOpen(false)
              useUIStore.getState().setLinkedProjectsModalOpen(true)
            }}
          >
            <Link2 className="h-4 w-4" />
            Linked Projects
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              K
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setMenuOpen(false)
              window.dispatchEvent(new CustomEvent('open-recap'))
            }}
          >
            <Sparkles className="h-4 w-4" />
            Create Recap
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              T
            </span>
          </DropdownMenuItem>

          {(loadedIssueContexts.length > 0 ||
            loadedPRContexts.length > 0 ||
            loadedSecurityContexts.length > 0 ||
            loadedAdvisoryContexts.length > 0 ||
            loadedLinearContexts.length > 0 ||
            attachedSavedContexts.length > 0) && (
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

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Commit
          </div>
          <DropdownMenuItem onClick={onCommit}>
            <GitCommitHorizontal className="h-4 w-4" />
            Commit
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              C
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCommitAndPush}>
            <GitCommitHorizontal className="h-4 w-4" />
            Commit & Push
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              P
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Sync
          </div>
          <DropdownMenuItem onClick={handlePullClick}>
            <ArrowDownToLine className="h-4 w-4" />
            Pull
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              D
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handlePushClick}>
            <ArrowUpToLine className="h-4 w-4" />
            Push
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              U
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Pull Request
          </div>
          <DropdownMenuItem onClick={onOpenPr}>
            <GitPullRequest className="h-4 w-4" />
            {hasOpenPr ? 'Open' : 'Create'}
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              O
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onReview}>
            <Eye className="h-4 w-4" />
            Review
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              R
            </span>
          </DropdownMenuItem>
          {hasOpenPr && (
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false)
                useUIStore.getState().setReviewCommentsModalOpen(true)
              }}
            >
              <MessageSquare className="h-4 w-4" />
              Review Comments
              <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                V
              </span>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Release
          </div>
          <DropdownMenuItem
            onClick={() => {
              setMenuOpen(false)
              useUIStore.getState().setReleaseNotesModalOpen(true)
            }}
          >
            <FileText className="h-4 w-4" />
            Generate Notes
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              G
            </span>
          </DropdownMenuItem>
          {hasOpenPr && (
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false)
                useUIStore.getState().setUpdatePrModalOpen(true)
              }}
            >
              <RefreshCw className="h-4 w-4" />
              PR Description
              <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                E
              </span>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Investigate
          </div>
          <DropdownMenuItem
            onClick={() => {
              setMenuOpen(false)
              window.dispatchEvent(
                new CustomEvent('magic-command', {
                  detail: { command: 'investigate', type: 'issue' },
                })
              )
            }}
          >
            <Bug className="h-4 w-4" />
            Issue
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              I
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setMenuOpen(false)
              window.dispatchEvent(
                new CustomEvent('magic-command', {
                  detail: { command: 'investigate', type: 'pr' },
                })
              )
            }}
          >
            <GitPullRequestArrow className="h-4 w-4" />
            PR
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              A
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Branch
          </div>
          <DropdownMenuItem onClick={onMerge}>
            <GitMerge className="h-4 w-4" />
            Merge to Base
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              M
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onResolveConflicts}>
            <GitMerge className="h-4 w-4" />
            Resolve Conflicts
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              F
            </span>
          </DropdownMenuItem>

          {(uncommittedAdded > 0 ||
            uncommittedRemoved > 0 ||
            branchDiffAdded > 0 ||
            branchDiffRemoved > 0 ||
            prUrl) && <DropdownMenuSeparator />}

          {(uncommittedAdded > 0 || uncommittedRemoved > 0) && (
            <DropdownMenuItem onClick={handleUncommittedDiffClick}>
              <Pencil className="h-4 w-4" />
              <span>Uncommitted</span>
              <span className="ml-auto text-xs">
                <span className="text-green-500">+{uncommittedAdded}</span>
                {' / '}
                <span className="text-red-500">-{uncommittedRemoved}</span>
              </span>
            </DropdownMenuItem>
          )}

          {(branchDiffAdded > 0 || branchDiffRemoved > 0) && (
            <DropdownMenuItem onClick={handleBranchDiffClick}>
              <GitBranch className="h-4 w-4" />
              <span>Branch diff</span>
              <span className="ml-auto text-xs">
                <span className="text-green-500">+{branchDiffAdded}</span>
                {' / '}
                <span className="text-red-500">-{branchDiffRemoved}</span>
              </span>
            </DropdownMenuItem>
          )}

          {prUrl && prNumber && (
            <DropdownMenuItem asChild>
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  displayStatus
                    ? getPrStatusDisplay(displayStatus).className
                    : ''
                )}
              >
                {displayStatus === 'merged' ? (
                  <GitMerge className="h-4 w-4" />
                ) : (
                  <GitPullRequest className="h-4 w-4" />
                )}
                <span>#{prNumber}</span>
                <CheckStatusButton
                  status={checkStatus ?? null}
                  projectPath={activeWorktreePath}
                />
              </a>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {!sessionHasMessages && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
                <Sparkles className="mr-2 h-4 w-4" />
                <span>Backend</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground capitalize">
                  {selectedBackend}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
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
                      Codex{' '}
                      <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                        BETA
                      </span>
                    </DropdownMenuRadioItem>
                  )}
                  {installedBackends.includes('opencode') && (
                    <DropdownMenuRadioItem value="opencode">
                      OpenCode{' '}
                      <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                        BETA
                      </span>
                    </DropdownMenuRadioItem>
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {customCliProfiles.length > 0 &&
            !providerLocked &&
            selectedBackend === 'claude' && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Sparkles className="mr-2 h-4 w-4" />
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

          {isMobile ? (
            <DropdownMenuItem onSelect={openModelSheet}>
              <Bot className="h-4 w-4 text-foreground" />
              <span>Model</span>
              <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                {selectedModelLabel}
              </span>
              <ChevronRight className="ml-2 h-4 w-4 shrink-0" />
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
                <Bot className="mr-2 h-4 w-4 text-foreground" />
                <span>Model</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                  {selectedModelLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {providerLocked && customCliProfiles.length > 0 && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Provider: {providerDisplayName}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuRadioGroup
                  value={selectedModel}
                  onValueChange={handleModelChange}
                >
                  {filteredModelOptions.map(option => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {hideThinkingLevel ? null : useAdaptiveThinking || isCodex ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
                <Brain className="mr-2 h-4 w-4" />
                <span>Effort</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                  {
                    EFFORT_LEVEL_OPTIONS.find(
                      o => o.value === selectedEffortLevel
                    )?.label
                  }
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedEffortLevel}
                  onValueChange={handleEffortLevelChange}
                >
                  {EFFORT_LEVEL_OPTIONS.map(option => (
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
                <Brain className="mr-2 h-4 w-4" />
                <span>Thinking</span>
                <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                  {
                    THINKING_LEVEL_OPTIONS.find(
                      o => o.value === selectedThinkingLevel
                    )?.label
                  }
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedThinkingLevel}
                  onValueChange={handleThinkingLevelChange}
                >
                  {THINKING_LEVEL_OPTIONS.map(option => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                      <span className="ml-auto pl-4 text-xs text-muted-foreground">
                        {option.tokens}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
              {executionMode === 'plan' && (
                <ClipboardList className="mr-2 h-4 w-4" />
              )}
              {executionMode === 'build' && <Hammer className="mr-2 h-4 w-4" />}
              {executionMode === 'yolo' && <Zap className="mr-2 h-4 w-4" />}
              <span>Mode</span>
              <span className="ml-auto w-16 text-right text-xs text-muted-foreground capitalize">
                {executionMode}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={executionMode}
                onValueChange={v => onSetExecutionMode(v as ExecutionMode)}
              >
                <DropdownMenuRadioItem value="plan">Plan</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="build">
                  Build
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator />
                <DropdownMenuRadioItem
                  value="yolo"
                  className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                >
                  Yolo
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="[&>svg:last-child]:!ml-2">
              <Plug
                className={cn(
                  'mr-2 h-4 w-4',
                  activeMcpCount > 0 && 'text-emerald-600 dark:text-emerald-400'
                )}
              />
              <span>MCP</span>
              <span className="ml-auto w-16 text-right text-xs text-muted-foreground">
                {activeMcpCount > 0 ? `${activeMcpCount} on` : 'off'}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
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
                      {(grouped[backend] ?? []).map(server => (
                        <DropdownMenuCheckboxItem
                          key={`${backend}-${server.name}`}
                          checked={
                            !server.disabled &&
                            enabledMcpServers.includes(server.name)
                          }
                          onCheckedChange={() => onToggleMcpServer(server.name)}
                          disabled={server.disabled}
                          className={server.disabled ? 'opacity-50' : undefined}
                        >
                          {server.name}
                          <span className="ml-auto pl-4 text-xs text-muted-foreground">
                            {server.disabled ? 'disabled' : server.scope}
                          </span>
                        </DropdownMenuCheckboxItem>
                      ))}
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
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <Sheet open={modelSheetOpen} onOpenChange={setModelSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[75svh] rounded-t-xl p-0"
          showCloseButton={false}
        >
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-base">Select Model</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto p-2">
            <div className="px-2 pb-2">
              <input
                value={modelSearchQuery}
                onChange={event => setModelSearchQuery(event.target.value)}
                placeholder="Search models..."
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none ring-0 focus:border-ring focus:ring-1 focus:ring-ring"
                autoFocus
              />
            </div>
            {providerLocked && customCliProfiles.length > 0 && (
              <div className="px-2 pb-1 text-xs text-muted-foreground">
                Provider: {providerDisplayName}
              </div>
            )}
            {visibleModelOptions.map(option => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                  selectedModel === option.value &&
                    'bg-accent text-accent-foreground'
                )}
                onClick={() => {
                  handleModelChange(option.value)
                  setModelSheetOpen(false)
                }}
              >
                <span className="flex-1">{option.label}</span>
                {selectedModel === option.value && (
                  <Check className="h-4 w-4" />
                )}
              </button>
            ))}
            {visibleModelOptions.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                No models match your search.
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
