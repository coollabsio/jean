import { memo, useCallback, useState } from 'react'
import { toast } from 'sonner'
import { gitPull, gitPush, triggerImmediateGitPoll } from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  Brain,
  ChevronDown,
  CircleDot,
  Clock,
  ClipboardList,
  Eye,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hammer,
  MoreHorizontal,
  Pencil,
  Send,
  Wand2,
  Zap,
} from 'lucide-react'
import { RiAnthropicFill, RiGeminiFill } from 'react-icons/ri'
import { SiOpenai } from 'react-icons/si'
import { Kbd } from '@/components/ui/kbd'
import {
  DropdownMenu,
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import type { ThinkingLevel, ExecutionMode } from '@/types/chat'
import type { AiCliProvider } from '@/types/preferences'
import {
  claudeModelOptions,
  geminiModelOptions,
  codexModelOptions,
  getModelOptionsForProvider,
} from '@/types/preferences'
import type { PrDisplayStatus, CheckStatus, MergeableStatus } from '@/types/pr-status'
import type { DiffRequest } from '@/types/git-diff'
import type {
  LoadedIssueContext,
  LoadedPullRequestContext,
  AttachedSavedContext,
} from '@/types/github'
import {
  getIssueContextContent,
  getPRContextContent,
  getSavedContextContent,
} from '@/services/github'

/** Get provider icon component */
function ProviderIcon({ provider, className }: { provider: AiCliProvider; className?: string }) {
  switch (provider) {
    case 'claude':
      return <RiAnthropicFill className={className} />
    case 'gemini':
      return <RiGeminiFill className={className} />
    case 'codex':
      return <SiOpenai className={className} />
    default:
      return <RiAnthropicFill className={className} />
  }
}

/** Get display label for a model */
function getModelLabel(model: string, provider: AiCliProvider): string {
  const options = getModelOptionsForProvider(provider)
  return options.find(o => o.value === model)?.label || model
}

/** Check if provider supports extended thinking */
function providerSupportsThinking(provider: AiCliProvider): boolean {
  return provider === 'claude'
}

/** Check if provider supports plan mode (approval before execution) */
function providerSupportsPlanMode(provider: AiCliProvider): boolean {
  // Only Claude has native plan mode with proper approval flow
  // Gemini CLI only supports YOLO mode (--yolo flag)
  // Codex doesn't handle plan approval well - keeps asking questions instead of implementing
  return provider === 'claude'
}

/** Thinking level options with display labels and token counts */
const THINKING_LEVEL_OPTIONS: {
  value: ThinkingLevel
  label: string
  tokens: string
}[] = [
    { value: 'off', label: 'Off', tokens: 'Disabled' },
    { value: 'think', label: 'Think', tokens: '4K' },
    { value: 'megathink', label: 'Megathink', tokens: '10K' },
    { value: 'ultrathink', label: 'Ultrathink', tokens: '32K' },
  ]

/** Get display label and color for PR status */
function getPrStatusDisplay(status: PrDisplayStatus): {
  label: string
  className: string
} {
  switch (status) {
    case 'draft':
      return { label: 'Draft', className: 'text-muted-foreground' }
    case 'open':
      return { label: 'Open', className: 'text-green-600 dark:text-green-500' }
    case 'merged':
      return {
        label: 'Merged',
        className: 'text-purple-600 dark:text-purple-400',
      }
    case 'closed':
      return { label: 'Closed', className: 'text-red-600 dark:text-red-400' }
    default:
      return { label: 'Unknown', className: 'text-muted-foreground' }
  }
}

/** Check status icon component */
function CheckStatusIcon({ status }: { status: CheckStatus | null }) {
  if (!status) return null

  switch (status) {
    case 'success':
      return null
    case 'failure':
    case 'error':
      return (
        <span
          className="ml-1 h-2 w-2 rounded-full bg-red-500"
          title="Checks failing"
        />
      )
    case 'pending':
      return (
        <span
          className="ml-1 h-2 w-2 rounded-full bg-yellow-500 animate-pulse"
          title="Checks pending"
        />
      )
    default:
      return null
  }
}

interface ChatToolbarProps {
  // State
  isSending: boolean
  hasPendingQuestions: boolean
  hasPendingAttachments: boolean
  hasInputValue: boolean
  executionMode: ExecutionMode
  selectedProvider: AiCliProvider
  selectedModel: string
  selectedThinkingLevel: ThinkingLevel
  thinkingOverrideActive: boolean // True when thinking is disabled in build/yolo due to preference
  queuedMessageCount: number

  // Git state
  hasBranchUpdates: boolean
  behindCount: number
  aheadCount: number
  baseBranch: string
  uncommittedAdded: number
  uncommittedRemoved: number
  branchDiffAdded: number
  branchDiffRemoved: number

  // PR state
  prUrl: string | undefined
  prNumber: number | undefined
  displayStatus: PrDisplayStatus | undefined
  checkStatus: CheckStatus | undefined
  mergeableStatus: MergeableStatus | undefined

  // Shortcuts
  magicModalShortcut: string

  // Worktree info
  activeWorktreePath: string | undefined
  worktreeId: string | null

  // Issue/PR/Saved context
  loadedIssueContexts: LoadedIssueContext[]
  loadedPRContexts: LoadedPullRequestContext[]
  attachedSavedContexts: AttachedSavedContext[]

  // Callbacks
  onOpenMagicModal: () => void
  onSaveContext: () => void
  onLoadContext: () => void
  onCommit: () => void
  onOpenPr: () => void
  onReview: () => void
  onMerge: () => void
  onResolvePrConflicts: () => void
  onResolveConflicts: () => void
  isBaseSession: boolean
  hasOpenPr: boolean
  onSetDiffRequest: (request: DiffRequest) => void
  onProviderChange: (provider: AiCliProvider) => void
  onModelChange: (model: string) => void
  onThinkingLevelChange: (level: ThinkingLevel) => void
  onSetExecutionMode: (mode: ExecutionMode) => void
  onCancel: () => void
}

/**
 * Memoized toolbar component to prevent re-renders when parent state changes.
 * This component only re-renders when its props change.
 */
export const ChatToolbar = memo(function ChatToolbar({
  isSending,
  hasPendingQuestions,
  hasPendingAttachments,
  hasInputValue,
  executionMode,
  selectedProvider,
  selectedModel,
  selectedThinkingLevel,
  thinkingOverrideActive,
  queuedMessageCount,
  hasBranchUpdates,
  behindCount,
  aheadCount,
  baseBranch,
  uncommittedAdded,
  uncommittedRemoved,
  branchDiffAdded,
  branchDiffRemoved,
  prUrl,
  prNumber,
  displayStatus,
  checkStatus,
  mergeableStatus,
  magicModalShortcut,
  activeWorktreePath,
  worktreeId,
  loadedIssueContexts,
  loadedPRContexts,
  attachedSavedContexts,
  onOpenMagicModal,
  onSaveContext,
  onLoadContext,
  onCommit,
  onOpenPr,
  onReview,
  onMerge,
  onResolvePrConflicts,
  onResolveConflicts,
  isBaseSession,
  hasOpenPr,
  onSetDiffRequest,
  onProviderChange,
  onModelChange,
  onThinkingLevelChange,
  onSetExecutionMode,
  onCancel,
}: ChatToolbarProps) {
  // Check if thinking is supported by current provider
  const thinkingSupported = providerSupportsThinking(selectedProvider)

  // Memoize callbacks to prevent re-renders
  const handleModelChange = useCallback(
    (value: string) => {
      onModelChange(value)
    },
    [onModelChange]
  )

  const handleProviderChange = useCallback(
    (provider: AiCliProvider) => {
      onProviderChange(provider)
    },
    [onProviderChange]
  )

  const handleThinkingLevelChange = useCallback(
    (value: string) => {
      onThinkingLevelChange(value as ThinkingLevel)
    },
    [onThinkingLevelChange]
  )

  const [isPulling, setIsPulling] = useState(false)
  const handlePullClick = useCallback(async () => {
    if (!activeWorktreePath || !worktreeId) return
    setIsPulling(true)
    const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
    setWorktreeLoading(worktreeId, 'pull')
    const toastId = toast.loading('Pulling changes...')
    try {
      await gitPull(activeWorktreePath, baseBranch)
      triggerImmediateGitPoll()
      toast.success('Changes pulled', { id: toastId })
    } catch (error) {
      // Tauri errors may be strings or Error objects with the message
      // Use String() to coerce any error type to a string for matching
      const errorStr = String(error)
      console.log('[ChatToolbar] Pull error:', { error, errorStr, type: typeof error })
      if (errorStr.includes('Merge conflicts in:')) {
        toast.warning('Pull resulted in conflicts', {
          id: toastId,
          description: 'Opening conflict resolution...',
        })
        onResolveConflicts()
      } else {
        toast.error(`Pull failed: ${errorStr}`, { id: toastId })
      }
    } finally {
      setIsPulling(false)
      clearWorktreeLoading(worktreeId)
    }
  }, [activeWorktreePath, baseBranch, onResolveConflicts])

  const [isPushing, setIsPushing] = useState(false)
  const handlePushClick = useCallback(async () => {
    if (!activeWorktreePath) return
    setIsPushing(true)
    const toastId = toast.loading('Pushing changes...')
    try {
      await gitPush(activeWorktreePath)
      triggerImmediateGitPoll()
      toast.success('Changes pushed', { id: toastId })
    } catch (error) {
      toast.error(`Push failed: ${error}`, { id: toastId })
    } finally {
      setIsPushing(false)
    }
  }, [activeWorktreePath, baseBranch, worktreeId])

  const handleUncommittedDiffClick = useCallback(() => {
    onSetDiffRequest({
      type: 'uncommitted',
      worktreePath: activeWorktreePath ?? '',
      baseBranch,
    })
  }, [activeWorktreePath, baseBranch, onSetDiffRequest])

  const handleBranchDiffClick = useCallback(() => {
    onSetDiffRequest({
      type: 'branch',
      worktreePath: activeWorktreePath ?? '',
      baseBranch,
    })
  }, [activeWorktreePath, baseBranch, onSetDiffRequest])

  // Context viewer state
  const [viewingContext, setViewingContext] = useState<{
    type: 'issue' | 'pr' | 'saved'
    number?: number
    slug?: string
    title: string
    content: string
  } | null>(null)

  const handleViewIssue = useCallback(
    async (ctx: LoadedIssueContext) => {
      if (!worktreeId || !activeWorktreePath) return
      try {
        const content = await getIssueContextContent(worktreeId, ctx.number, activeWorktreePath)
        setViewingContext({ type: 'issue', number: ctx.number, title: ctx.title, content })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [worktreeId, activeWorktreePath]
  )

  const handleViewPR = useCallback(
    async (ctx: LoadedPullRequestContext) => {
      if (!worktreeId || !activeWorktreePath) return
      try {
        const content = await getPRContextContent(worktreeId, ctx.number, activeWorktreePath)
        setViewingContext({ type: 'pr', number: ctx.number, title: ctx.title, content })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [worktreeId, activeWorktreePath]
  )

  const handleViewSavedContext = useCallback(
    async (ctx: AttachedSavedContext) => {
      if (!worktreeId) return
      try {
        const content = await getSavedContextContent(worktreeId, ctx.slug)
        setViewingContext({
          type: 'saved',
          slug: ctx.slug,
          title: ctx.name || ctx.slug,
          content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [worktreeId]
  )

  // Compute counts from arrays
  const loadedIssueCount = loadedIssueContexts.length
  const loadedPRCount = loadedPRContexts.length
  const loadedContextCount = attachedSavedContexts.length

  const isDisabled = isSending || hasPendingQuestions
  const canSend = hasInputValue || hasPendingAttachments

  return (
    <div className="@container px-4 py-2 md:px-6">
      {/* Controls - segmented button group */}
      <div className="inline-flex items-center rounded-lg bg-muted/50">
        {/* Mobile overflow menu - only visible on small screens */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex @md:hidden h-8 items-center gap-1 rounded-l-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={isDisabled}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {/* Core section */}
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Core
            </div>
            <DropdownMenuItem onClick={onSaveContext}>
              <BookmarkPlus className="h-4 w-4" />
              Save Context
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onLoadContext}>
              <FolderOpen className="h-4 w-4" />
              Load Context
              {(loadedIssueCount > 0 || loadedPRCount > 0 || loadedContextCount > 0) && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {loadedIssueCount + loadedPRCount + loadedContextCount} loaded
                </span>
              )}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Git section */}
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Git
            </div>
            <DropdownMenuItem onClick={onCommit}>
              <GitCommitHorizontal className="h-4 w-4" />
              Commit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenPr}>
              <GitPullRequest className="h-4 w-4" />
              Open PR
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReview}>
              <Eye className="h-4 w-4" />
              Review
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onMerge}
              disabled={isBaseSession || hasOpenPr}
            >
              <GitMerge className="h-4 w-4" />
              Merge to Base
            </DropdownMenuItem>

            {/* Git stats section - conditional */}
            {(hasBranchUpdates ||
              uncommittedAdded > 0 ||
              uncommittedRemoved > 0 ||
              branchDiffAdded > 0 ||
              branchDiffRemoved > 0 ||
              prUrl) && <DropdownMenuSeparator />}

            {/* Pull button */}
            {hasBranchUpdates && (
              <DropdownMenuItem onClick={handlePullClick} disabled={isPulling}>
                <ArrowDown className="h-4 w-4" />
                Pull {behindCount} commit{behindCount === 1 ? '' : 's'}
              </DropdownMenuItem>
            )}

            {/* Push button */}
            {aheadCount > 0 && (
              <DropdownMenuItem onClick={handlePushClick} disabled={isPushing}>
                <ArrowUp className="h-4 w-4" />
                Push {aheadCount} commit{aheadCount === 1 ? '' : 's'}
              </DropdownMenuItem>
            )}

            {/* Uncommitted diff */}
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

            {/* Branch diff */}
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

            {/* PR link */}
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
                  <span>
                    {displayStatus
                      ? getPrStatusDisplay(displayStatus).label
                      : 'Open'}{' '}
                    #{prNumber}
                  </span>
                  <CheckStatusIcon status={checkStatus ?? null} />
                </a>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />

            {/* Provider/Model selector - Claude */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <RiAnthropicFill className="mr-2 h-4 w-4" />
                <span>Claude</span>
                {selectedProvider === 'claude' && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {getModelLabel(selectedModel, 'claude')}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider === 'claude' ? selectedModel : ''}
                  onValueChange={(value) => {
                    handleProviderChange('claude')
                    handleModelChange(value)
                  }}
                >
                  {claudeModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Provider/Model selector - Gemini */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <RiGeminiFill className="mr-2 h-4 w-4" />
                <span>Gemini</span>
                {selectedProvider === 'gemini' && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {getModelLabel(selectedModel, 'gemini')}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider === 'gemini' ? selectedModel : ''}
                  onValueChange={(value) => {
                    handleProviderChange('gemini')
                    handleModelChange(value)
                  }}
                >
                  {geminiModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Provider/Model selector - OpenAI */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SiOpenai className="mr-2 h-4 w-4" />
                <span>Codex</span>
                {selectedProvider === 'codex' && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {getModelLabel(selectedModel, 'codex')}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider === 'codex' ? selectedModel : ''}
                  onValueChange={(value) => {
                    handleProviderChange('codex')
                    handleModelChange(value)
                  }}
                >
                  {codexModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Thinking level as submenu - only for Claude */}
            {thinkingSupported && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Brain className="mr-2 h-4 w-4" />
                  <span>Thinking</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {thinkingOverrideActive
                      ? 'Off'
                      : THINKING_LEVEL_OPTIONS.find(
                        o => o.value === selectedThinkingLevel
                      )?.label}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={thinkingOverrideActive ? 'off' : selectedThinkingLevel}
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

            {/* Execution mode as submenu - only for providers that support plan mode */}
            {providerSupportsPlanMode(selectedProvider) ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {executionMode === 'plan' && (
                    <ClipboardList className="mr-2 h-4 w-4" />
                  )}
                  {executionMode === 'build' && (
                    <Hammer className="mr-2 h-4 w-4" />
                  )}
                  {executionMode === 'yolo' && <Zap className="mr-2 h-4 w-4" />}
                  <span>Mode</span>
                  <span className="ml-auto text-xs text-muted-foreground capitalize">
                    {executionMode}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={executionMode}
                    onValueChange={v => onSetExecutionMode(v as ExecutionMode)}
                  >
                    <DropdownMenuRadioItem value="plan">
                      Plan
                    </DropdownMenuRadioItem>
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
            ) : (
              /* Gemini only supports YOLO mode - show indicator */
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                <Zap className="h-4 w-4 text-yellow-500" />
                <span>Auto mode only</span>
              </div>
            )}

            {/* Queue indicator */}
            {queuedMessageCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>{queuedMessageCount} queued</span>
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Divider after overflow menu - mobile only */}
        <div className="block @md:hidden h-4 w-px bg-border/50" />

        {/* Magic modal button - desktop only */}
        <button
          type="button"
          className="hidden @md:flex h-8 items-center gap-1 rounded-l-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isDisabled}
          onClick={onOpenMagicModal}
        >
          <Wand2 className="h-3.5 w-3.5" />
          <Kbd className="ml-0.5 h-4 text-[10px] opacity-50">
            {magicModalShortcut}
          </Kbd>
        </button>

        {/* Issue/PR/Context dropdown - desktop only */}
        {(loadedIssueCount > 0 || loadedPRCount > 0 || loadedContextCount > 0) && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                >
                  <CircleDot className="h-3.5 w-3.5" />
                  <span>
                    {loadedIssueCount > 0 &&
                      `${loadedIssueCount} Issue${loadedIssueCount > 1 ? 's' : ''}`}
                    {loadedIssueCount > 0 && (loadedPRCount > 0 || loadedContextCount > 0) && ', '}
                    {loadedPRCount > 0 && `${loadedPRCount} PR${loadedPRCount > 1 ? 's' : ''}`}
                    {loadedPRCount > 0 && loadedContextCount > 0 && ', '}
                    {loadedContextCount > 0 &&
                      `${loadedContextCount} Context${loadedContextCount > 1 ? 's' : ''}`}
                  </span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {/* Issues section */}
                {loadedIssueContexts.length > 0 && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Issues
                    </DropdownMenuLabel>
                    {loadedIssueContexts.map((ctx) => (
                      <DropdownMenuItem key={ctx.number} onClick={() => handleViewIssue(ctx)}>
                        <CircleDot className="h-4 w-4 text-green-500" />
                        <span className="truncate">
                          #{ctx.number} {ctx.title}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </>
                )}

                {/* PRs section */}
                {loadedPRContexts.length > 0 && (
                  <>
                    {loadedIssueContexts.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Pull Requests
                    </DropdownMenuLabel>
                    {loadedPRContexts.map((ctx) => (
                      <DropdownMenuItem key={ctx.number} onClick={() => handleViewPR(ctx)}>
                        <GitPullRequest className="h-4 w-4 text-green-500" />
                        <span className="truncate">
                          #{ctx.number} {ctx.title}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </>
                )}

                {/* Saved contexts section */}
                {attachedSavedContexts.length > 0 && (
                  <>
                    {(loadedIssueContexts.length > 0 || loadedPRContexts.length > 0) && (
                      <DropdownMenuSeparator />
                    )}
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Contexts
                    </DropdownMenuLabel>
                    {attachedSavedContexts.map((ctx) => (
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

                {/* Manage button */}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onLoadContext}>
                  <FolderOpen className="h-4 w-4" />
                  Manage Contexts...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {/* Pull button - shown when behind base branch (desktop only) */}
        {hasBranchUpdates && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <button
              type="button"
              className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              onClick={handlePullClick}
              disabled={isPulling}
              title={`${behindCount} commit${behindCount === 1 ? '' : 's'} behind ${baseBranch}`}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>Pull {behindCount}</span>
            </button>
          </>
        )}

        {/* Push button - shown when ahead of remote (desktop only) */}
        {aheadCount > 0 && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <button
              type="button"
              className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-orange-500 transition-colors hover:bg-muted/80 hover:text-orange-400 disabled:pointer-events-none disabled:opacity-50"
              onClick={handlePushClick}
              disabled={isPushing}
              title={`${aheadCount} unpushed commit${aheadCount === 1 ? '' : 's'}`}
            >
              <ArrowUp className="h-3.5 w-3.5" />
              <span>Push {aheadCount}</span>
            </button>
          </>
        )}

        {/* Uncommitted diff stats - desktop only */}
        {(uncommittedAdded > 0 || uncommittedRemoved > 0) && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <button
              type="button"
              className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground hover:bg-muted/80 transition-colors cursor-pointer"
              title="Click to view uncommitted changes"
              onClick={handleUncommittedDiffClick}
            >
              <Pencil className="h-3 w-3" />
              <span className="text-green-500">+{uncommittedAdded}</span>
              <span>/</span>
              <span className="text-red-500">-{uncommittedRemoved}</span>
            </button>
          </>
        )}

        {/* Branch diff stats - desktop only */}
        {(branchDiffAdded > 0 || branchDiffRemoved > 0) && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <button
              type="button"
              className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground hover:bg-muted/80 transition-colors cursor-pointer"
              title={`Click to view diff vs ${baseBranch}`}
              onClick={handleBranchDiffClick}
            >
              <GitBranch className="h-3 w-3" />
              <span className="text-green-500">+{branchDiffAdded}</span>
              <span>/</span>
              <span className="text-red-500">-{branchDiffRemoved}</span>
            </button>
          </>
        )}

        {/* PR link indicator - desktop only */}
        {prUrl && prNumber && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm transition-colors select-none hover:bg-muted/80 hover:text-foreground',
                displayStatus
                  ? getPrStatusDisplay(displayStatus).className
                  : 'text-muted-foreground'
              )}
              title={`Open PR #${prNumber} on GitHub`}
            >
              {displayStatus === 'merged' ? (
                <GitMerge className="h-3.5 w-3.5" />
              ) : (
                <GitPullRequest className="h-3.5 w-3.5" />
              )}
              <span>
                {displayStatus
                  ? getPrStatusDisplay(displayStatus).label
                  : 'Open'}{' '}
                #{prNumber}
              </span>
              <CheckStatusIcon status={checkStatus ?? null} />
            </a>
          </>
        )}

        {/* PR conflicts indicator - desktop only */}
        {mergeableStatus === 'conflicting' && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <button
              type="button"
              className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-amber-600 dark:text-amber-400 transition-colors cursor-pointer hover:bg-muted/80"
              title="PR has merge conflicts — click to resolve"
              onClick={onResolvePrConflicts}
            >
              <GitMerge className="h-3 w-3" />
              <span>Conflicts</span>
            </button>
          </>
        )}

        {/* Divider - desktop only */}
        <div className="hidden @md:block h-4 w-px bg-border/50" />

        {/* Provider/Model selector - desktop only */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={hasPendingQuestions}
              className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              title={`${selectedProvider}: ${getModelLabel(selectedModel, selectedProvider)}`}
            >
              <ProviderIcon provider={selectedProvider} className="h-3.5 w-3.5" />
              <span>{getModelLabel(selectedModel, selectedProvider)}</span>
              <ChevronDown className="h-3 w-3 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {/* Claude models */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <RiAnthropicFill className="mr-2 h-4 w-4" />
                <span>Anthropic</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider === 'claude' ? selectedModel : ''}
                  onValueChange={(value) => {
                    handleProviderChange('claude')
                    handleModelChange(value)
                  }}
                >
                  {claudeModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Gemini models */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <RiGeminiFill className="mr-2 h-4 w-4" />
                <span>Google</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider === 'gemini' ? selectedModel : ''}
                  onValueChange={(value) => {
                    handleProviderChange('gemini')
                    handleModelChange(value)
                  }}
                >
                  {geminiModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Codex models */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SiOpenai className="mr-2 h-4 w-4" />
                <span>OpenAI</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={selectedProvider === 'codex' ? selectedModel : ''}
                  onValueChange={(value) => {
                    handleProviderChange('codex')
                    handleModelChange(value)
                  }}
                >
                  {codexModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Thinking level dropdown - desktop only (Claude only) */}
        {thinkingSupported && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={hasPendingQuestions}
                  className={cn(
                    'hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                    selectedThinkingLevel !== 'off' &&
                    !thinkingOverrideActive &&
                    'border border-purple-500/50 bg-purple-500/10 text-purple-700 dark:border-purple-400/40 dark:bg-purple-500/10 dark:text-purple-400'
                  )}
                  title={
                    thinkingOverrideActive
                      ? `Thinking disabled in ${executionMode} mode (change in Settings)`
                      : `Thinking: ${THINKING_LEVEL_OPTIONS.find(o => o.value === selectedThinkingLevel)?.label}`
                  }
                >
                  <Brain className="h-3.5 w-3.5" />
                  <span>
                    {thinkingOverrideActive
                      ? 'Off'
                      : THINKING_LEVEL_OPTIONS.find(
                        o => o.value === selectedThinkingLevel
                      )?.label}
                  </span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={thinkingOverrideActive ? 'off' : selectedThinkingLevel}
                  onValueChange={handleThinkingLevelChange}
                >
                  {THINKING_LEVEL_OPTIONS.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      <Brain className="mr-2 h-4 w-4" />
                      {option.label}
                      <span className="ml-auto pl-4 text-xs text-muted-foreground">
                        {option.tokens}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {/* Divider - desktop only (only show if provider supports plan mode) */}
        {providerSupportsPlanMode(selectedProvider) && (
          <div className="hidden @md:block h-4 w-px bg-border/50" />
        )}

        {/* Execution mode dropdown - desktop only (only for providers that support plan mode) */}
        {providerSupportsPlanMode(selectedProvider) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={hasPendingQuestions}
                className={cn(
                  'hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                  executionMode === 'plan' &&
                  'border border-yellow-600/50 bg-yellow-500/10 text-yellow-700 dark:border-yellow-500/40 dark:bg-yellow-500/10 dark:text-yellow-400',
                  executionMode === 'yolo' &&
                  'border border-red-500/50 bg-red-500/10 text-red-600 dark:border-red-400/40 dark:text-red-400'
                )}
                title={`${executionMode.charAt(0).toUpperCase() + executionMode.slice(1)} mode (Shift+Tab to cycle)`}
              >
                {executionMode === 'plan' && (
                  <ClipboardList className="h-3.5 w-3.5" />
                )}
                {executionMode === 'build' && <Hammer className="h-3.5 w-3.5" />}
                {executionMode === 'yolo' && <Zap className="h-3.5 w-3.5" />}
                <span className="capitalize">{executionMode}</span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
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
        ) : (
          /* Gemini - show auto mode indicator on desktop */
          <div className="hidden @md:flex h-8 items-center gap-1.5 px-3 text-sm text-yellow-600 dark:text-yellow-400">
            <Zap className="h-3.5 w-3.5" />
            <span>Auto</span>
          </div>
        )}

        {/* Queue indicator - desktop only */}
        {queuedMessageCount > 0 && (
          <>
            <div className="hidden @md:block h-4 w-px bg-border/50" />
            <div className="hidden @md:flex h-8 items-center gap-1.5 px-2 text-sm text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{queuedMessageCount} queued</span>
            </div>
          </>
        )}

        {/* Divider */}
        <div className="h-4 w-px bg-border/50" />

        {/* Send/Cancel button */}
        {isSending ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 items-center justify-center gap-1.5 rounded-r-lg px-3 text-sm transition-colors bg-primary text-primary-foreground hover:bg-primary/90"
            title="Cancel (Cmd+Option+Backspace)"
          >
            <span>Cancel</span>
            <Kbd className="ml-0.5 h-4 text-[10px] bg-primary-foreground/20 text-primary-foreground">
              {navigator.platform.includes('Mac') ? '⌘⌥⌫' : 'Ctrl+Alt+⌫'}
            </Kbd>
          </button>
        ) : (
          <button
            type="submit"
            disabled={hasPendingQuestions || !canSend}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 rounded-r-lg px-3 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
            )}
            title="Send message (Enter)"
          >
            <Send className="h-3.5 w-3.5" />
            <Kbd
              className={cn(
                'ml-0.5 h-4 text-[10px]',
                canSend
                  ? 'bg-primary-foreground/20 text-primary-foreground'
                  : 'opacity-50'
              )}
            >
              Enter
            </Kbd>
          </button>
        )}
      </div>

      {/* Context viewer dialog */}
      {viewingContext && (
        <Dialog open={true} onOpenChange={() => setViewingContext(null)}>
          <DialogContent className="!max-w-[calc(100vw-8rem)] !w-[calc(100vw-8rem)] !h-[calc(100vh-8rem)] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {viewingContext.type === 'issue' && (
                  <CircleDot className="h-4 w-4 text-green-500" />
                )}
                {viewingContext.type === 'pr' && (
                  <GitPullRequest className="h-4 w-4 text-green-500" />
                )}
                {viewingContext.type === 'saved' && (
                  <FolderOpen className="h-4 w-4 text-blue-500" />
                )}
                {viewingContext.number ? `#${viewingContext.number}: ` : ''}
                {viewingContext.title}
              </DialogTitle>
            </DialogHeader>
            <ScrollArea className="flex-1 min-h-0">
              <Markdown className="p-4">
                {viewingContext.content}
              </Markdown>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
})
