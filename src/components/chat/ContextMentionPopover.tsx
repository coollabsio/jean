import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ExternalLink,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
} from '@/components/icons/reicon'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { BOTTOM_UP_LIST_CLASS } from './mention-list'
import { isLinearAuthError } from '@/services/linear'
import { IssuePreviewModal } from '@/components/worktree/IssuePreviewModal'
import { ContextLinkBadge } from '@/components/worktree/ContextLinkBadge'
import { BulkInvestigateBar } from '@/components/worktree/BulkInvestigateBar'
import { ItemSelectCheckbox } from '@/components/worktree/ItemSelectCheckbox'
import {
  contextLinkMatchLabel,
  openContextLinkMatch,
  useContextLinkUsage,
  type ContextLinkRef,
} from '@/hooks/useContextLinkUsage'
import {
  type ContextMentionItem,
  useContextMentionData,
} from './hooks/useContextMentionData'

const githubContextQueries = new Set([
  'issues',
  'prs',
  'issue-search',
  'pr-search',
  'issue-by-number',
  'pr-by-number',
  'security-alerts',
  'security-alert',
  'advisories',
  'advisory',
])
const linearContextQueries = new Set([
  'issues',
  'issue-search',
  'issue-by-number',
])

const DEFAULT_LIST_LIMIT = 8
/**
 * "Load more" limits per project, filter, and search. Kept at module level so
 * they survive closing the menu; cleared only by refresh or an app restart.
 */
const loadedLimits = new Map<string, number>()

function limitKeyPrefix(projectPath: string | null, projectId: string | null) {
  return `${projectPath ?? ''}\0${projectId ?? ''}\0`
}

interface PreviewTarget {
  type: 'issue' | 'pr' | 'security' | 'advisory'
  number: number
  ghsaId?: string
}

function getPreviewTarget(item: ContextMentionItem): PreviewTarget | null {
  if (item.issue) return { type: 'issue', number: item.issue.number }
  if (item.pr) return { type: 'pr', number: item.pr.number }
  if (item.securityAlert)
    return { type: 'security', number: item.securityAlert.number }
  if (item.advisory)
    return { type: 'advisory', number: 0, ghsaId: item.advisory.ghsaId }
  return null
}

function getLinkRef(item: ContextMentionItem): ContextLinkRef | null {
  if (item.issue) return { type: 'issue', id: item.issue.number }
  if (item.pr) return { type: 'pr', id: item.pr.number }
  if (item.securityAlert)
    return { type: 'security', id: item.securityAlert.number }
  if (item.advisory) return { type: 'advisory', id: item.advisory.ghsaId }
  if (item.linearIssue)
    return { type: 'linear', id: item.linearIssue.identifier }
  return null
}

export interface ContextMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: (investigate?: boolean) => void
}

interface ContextMentionPopoverProps {
  projectPath: string | null
  projectId: string | null
  /** Current session; its own links are not reported as duplicates */
  sessionId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectContext: (item: ContextMentionItem, investigate?: boolean) => void
  /**
   * Enables multi-select of issues/PRs. `separate` starts one new session per
   * item; otherwise one new session investigates all of them.
   */
  onInvestigateInNewSession?: (
    items: ContextMentionItem[],
    separate: boolean
  ) => void
  searchQuery: string
  anchorPosition: { top: number; left: number } | null
  containerWidth?: number
  handleRef?: React.RefObject<ContextMentionPopoverHandle | null>
}

export function ContextMentionPopover({
  projectPath,
  projectId,
  sessionId,
  open,
  onOpenChange,
  onSelectContext,
  onInvestigateInNewSession,
  searchQuery,
  anchorPosition,
  containerWidth,
  handleRef,
}: ContextMentionPopoverProps) {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const showKeyboardHints = isNativeApp() && !isMobile
  const actionButtonClass = cn(
    'flex min-h-8 items-center gap-1 rounded hover:bg-muted',
    isMobile ? 'min-w-8 justify-center' : 'px-1.5'
  )
  const [includeClosed, setIncludeClosed] = useState(false)
  const [menuSearch, setMenuSearch] = useState('')
  const [, setLimitsVersion] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null)
  // Keyed by item id; kept across searches so items from several searches
  // can be investigated together
  const [checkedItems, setCheckedItems] = useState<
    Map<string, ContextMentionItem>
  >(() => new Map())
  const query = menuSearch || searchQuery
  const limitKey = (group: 'issue' | 'pr') =>
    `${limitKeyPrefix(projectPath, projectId)}${includeClosed}\0${group}\0${query}`
  const issueLimit = loadedLimits.get(limitKey('issue')) ?? DEFAULT_LIST_LIMIT
  const prLimit = loadedLimits.get(limitKey('pr')) ?? DEFAULT_LIST_LIMIT
  const loadMore = (group: 'issue' | 'pr') => {
    const limit = group === 'issue' ? issueLimit : prLimit
    loadedLimits.set(limitKey(group), limit + DEFAULT_LIST_LIMIT)
    setLimitsVersion(version => version + 1)
  }
  const { groups, isFetching } = useContextMentionData({
    open,
    projectPath,
    projectId,
    query,
    includeClosed,
    issueLimit,
    prLimit,
  })
  const { getMatches, currentWorktreeId } = useContextLinkUsage({
    enabled: open,
    projectId,
    projectPath,
    currentSessionId: sessionId,
  })
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const flatItems = useMemo(
    () => groups.flatMap(group => group.items),
    [groups]
  )

  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, flatItems.length - 1)
  )

  const handleSelect = useCallback(
    (item: ContextMentionItem, investigate = false) => {
      onOpenChange(false)
      // Do not start a second investigation of an item that already has one
      const linkRef = investigate ? getLinkRef(item) : null
      const existing = linkRef ? getMatches(linkRef)[0] : undefined
      if (existing) {
        openContextLinkMatch(existing)
        toast.info(
          `${item.label} is already in ${contextLinkMatchLabel(existing, currentWorktreeId)} — opened it`
        )
        return
      }
      onSelectContext(item, investigate)
    },
    [currentWorktreeId, getMatches, onOpenChange, onSelectContext]
  )

  const handleRefresh = useCallback(async () => {
    if (!projectPath && !projectId) return
    setIsRefreshing(true)
    const prefix = limitKeyPrefix(projectPath, projectId)
    for (const key of loadedLimits.keys()) {
      if (key.startsWith(prefix)) loadedLimits.delete(key)
    }
    setLimitsVersion(version => version + 1)
    const results = await Promise.allSettled([
      queryClient.invalidateQueries(
        {
          predicate: ({ queryKey }) =>
            Boolean(projectPath) &&
            queryKey[0] === 'github' &&
            queryKey[2] === projectPath &&
            githubContextQueries.has(String(queryKey[1])),
        },
        { throwOnError: true }
      ),
      queryClient.invalidateQueries(
        {
          predicate: ({ queryKey }) =>
            Boolean(projectId) &&
            queryKey[0] === 'linear' &&
            queryKey[2] === projectId &&
            linearContextQueries.has(String(queryKey[1])),
        },
        { throwOnError: true }
      ),
    ])
    setIsRefreshing(false)
    // Linear is optional: a missing/invalid key is not a refresh failure
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && !isLinearAuthError(result.reason)
    )
    if (failure) {
      toast.error(`Failed to refresh context links: ${failure.reason}`)
    }
  }, [projectId, projectPath, queryClient])

  const resetListPosition = useCallback(() => setSelectedIndex(0), [])

  // Prop-driven resets. Local filter changes (menuSearch, includeClosed)
  // reset in their own event handlers to avoid chaining effects.
  useEffect(() => {
    if (!open) return
    resetListPosition()
  }, [open, searchQuery, projectPath, resetListPosition])

  useEffect(() => {
    if (!open) return
    setMenuSearch('')
    setCheckedItems(new Map())
  }, [open])

  const toggleChecked = useCallback(
    (item: ContextMentionItem, checked: boolean) => {
      setCheckedItems(prev => {
        const next = new Map(prev)
        if (checked) next.set(item.id, item)
        else next.delete(item.id)
        return next
      })
    },
    []
  )

  const handleInvestigateChecked = useCallback(
    (separate: boolean) => {
      if (!onInvestigateInNewSession) return
      // Skip items that already have an investigation, like single Investigate
      const items = [...checkedItems.values()]
      const fresh = items.filter(item => {
        const linkRef = getLinkRef(item)
        return !linkRef || getMatches(linkRef).length === 0
      })
      const skipped = items.length - fresh.length
      if (skipped > 0) {
        toast.info(
          `Skipped ${skipped} already investigated ${skipped === 1 ? 'item' : 'items'}`
        )
      }
      if (fresh.length === 0) return
      onOpenChange(false)
      onInvestigateInNewSession(fresh, separate)
    },
    [checkedItems, getMatches, onInvestigateInNewSession, onOpenChange]
  )

  useImperativeHandle(
    handleRef,
    () => ({
      // List renders bottom-up: ArrowUp moves to the next (worse) match.
      moveUp: () =>
        setSelectedIndex(i =>
          Math.min(i + 1, Math.max(0, flatItems.length - 1))
        ),
      moveDown: () => setSelectedIndex(i => Math.max(i - 1, 0)),
      selectCurrent: (investigate = false) => {
        const item = flatItems[clampedSelectedIndex]
        if (item) handleSelect(item, investigate)
      },
    }),
    [clampedSelectedIndex, flatItems, handleSelect]
  )

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list
      .querySelector(`[data-flat-index="${clampedSelectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  if (!open || !anchorPosition) return null

  let flatIndex = -1

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        className="-mx-4 md:-mx-6"
        style={{
          position: 'absolute',
          top: anchorPosition.top,
          left: 0,
          right: 0,
          pointerEvents: 'none',
        }}
      />
      <PopoverContent
        className="p-0"
        style={containerWidth ? { width: containerWidth } : undefined}
        align="start"
        collisionPadding={0}
        side="top"
        sideOffset={20}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
        // Keep the list open while the preview modal is on top of it
        onInteractOutside={e => {
          if (previewTarget) e.preventDefault()
        }}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Context links
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Refresh context links"
              title="Refresh context links"
              disabled={isRefreshing || (!projectPath && !projectId)}
              onClick={() => void handleRefresh()}
              className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn('size-4', isRefreshing && 'animate-spin')}
              />
            </button>
            <button
              type="button"
              onClick={() => {
                setIncludeClosed(value => !value)
                resetListPosition()
              }}
              className={cn(
                'rounded px-2 py-1 text-xs transition-colors',
                includeClosed
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {includeClosed
                ? 'Showing closed/merged'
                : 'Include closed/merged'}
            </button>
          </div>
        </div>
        <Command label="Search issues and context links" shouldFilter={false}>
          <CommandInput
            placeholder="Search issue title or description..."
            value={menuSearch}
            onValueChange={value => {
              setMenuSearch(value)
              resetListPosition()
            }}
            onKeyDown={event => {
              event.stopPropagation()
              switch (event.key) {
                case 'ArrowUp':
                  event.preventDefault()
                  setSelectedIndex(index =>
                    Math.min(index + 1, Math.max(0, flatItems.length - 1))
                  )
                  break
                case 'ArrowDown':
                  event.preventDefault()
                  setSelectedIndex(index => Math.max(index - 1, 0))
                  break
                case 'Enter': {
                  event.preventDefault()
                  const item = flatItems[clampedSelectedIndex]
                  if (item) handleSelect(item, event.shiftKey)
                  break
                }
                case 'Escape':
                  event.preventDefault()
                  onOpenChange(false)
                  break
              }
            }}
          />
          <CommandList
            ref={listRef}
            className={cn(
              'min-h-[280px] max-h-[min(420px,60vh)]',
              BOTTOM_UP_LIST_CLASS
            )}
          >
            {flatItems.length === 0 ? (
              <CommandEmpty>
                <div className="flex items-center justify-center gap-2">
                  {isFetching && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  <span>
                    {isFetching ? 'Searching contexts...' : 'No contexts found'}
                  </span>
                </div>
              </CommandEmpty>
            ) : (
              groups.map(group => (
                <CommandGroup key={group.id} heading={group.heading}>
                  {group.items.map(item => {
                    flatIndex += 1
                    const itemIndex = flatIndex
                    const preview = projectPath ? getPreviewTarget(item) : null
                    const linkRef = getLinkRef(item)
                    const matches = linkRef ? getMatches(linkRef) : []
                    const existing = matches[0]
                    const isSelected = itemIndex === clampedSelectedIndex
                    return (
                      <CommandItem
                        key={item.id}
                        data-flat-index={itemIndex}
                        value={`${item.type}:${item.label}:${item.title}`}
                        onSelect={() => handleSelect(item)}
                        className={cn(
                          'flex items-start gap-2 cursor-pointer',
                          'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                          isSelected && '!bg-accent !text-accent-foreground'
                        )}
                      >
                        {onInvestigateInNewSession &&
                          (item.type === 'issue' || item.type === 'pr') && (
                            <div className="self-center">
                              <ItemSelectCheckbox
                                checked={checkedItems.has(item.id)}
                                ariaLabel={`Select ${item.label}`}
                                onCheckedChange={checked =>
                                  toggleChecked(item, checked)
                                }
                              />
                            </div>
                          )}
                        <div className="min-w-0 flex-1 self-center line-clamp-2 break-words text-sm">
                          <span className="mr-2 font-mono text-xs text-muted-foreground">
                            {item.label}
                          </span>
                          <span className="font-medium">{item.title}</span>
                        </div>
                        <ContextLinkBadge
                          matches={matches}
                          currentWorktreeId={currentWorktreeId}
                          onOpen={match => {
                            onOpenChange(false)
                            openContextLinkMatch(match)
                          }}
                        />
                        {item.badge && (
                          <span className="shrink-0 self-center rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {item.badge}
                          </span>
                        )}
                        {(item.type === 'issue' || item.type === 'pr') && (
                          <span className="flex shrink-0 items-center gap-1 self-center">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`Add ${item.label} to session context`}
                                  className={actionButtonClass}
                                  onClick={event => {
                                    event.stopPropagation()
                                    handleSelect(item)
                                  }}
                                >
                                  <Plus className="size-3.5" />
                                  {!isMobile && <span>Attach</span>}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="flex items-center gap-2">
                                Add {item.label} to session context
                                {showKeyboardHints && isSelected && (
                                  <Kbd>Enter</Kbd>
                                )}
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={
                                    existing
                                      ? `Open existing investigation of ${item.label}`
                                      : `Add ${item.label} and start investigating`
                                  }
                                  className={actionButtonClass}
                                  onClick={event => {
                                    event.stopPropagation()
                                    handleSelect(item, true)
                                  }}
                                >
                                  {existing ? (
                                    <ExternalLink className="size-3.5" />
                                  ) : (
                                    <Sparkles className="size-3.5" />
                                  )}
                                  {!isMobile && (
                                    <span>
                                      {existing ? 'Open' : 'Investigate'}
                                    </span>
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="flex items-center gap-2">
                                {existing
                                  ? `Open ${contextLinkMatchLabel(existing, currentWorktreeId)}`
                                  : `Add ${item.label} and start investigating`}
                                {showKeyboardHints && isSelected && (
                                  <Kbd>Shift+Enter</Kbd>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          </span>
                        )}
                        {preview && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label={`Preview ${item.label}`}
                                className={cn(
                                  actionButtonClass,
                                  'shrink-0 self-center min-w-8 justify-center'
                                )}
                                onClick={event => {
                                  event.stopPropagation()
                                  setPreviewTarget(preview)
                                }}
                              >
                                <Eye className="size-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              Preview {item.label}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </CommandItem>
                    )
                  })}
                  {group.hasMore &&
                    (group.id === 'issue' || group.id === 'pr') && (
                      <button
                        type="button"
                        className="w-full rounded px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        onClick={() =>
                          loadMore(group.id === 'issue' ? 'issue' : 'pr')
                        }
                      >
                        Load more{' '}
                        {group.id === 'issue' ? 'issues' : 'pull requests'}
                      </button>
                    )}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
        {onInvestigateInNewSession && checkedItems.size > 0 && (
          <BulkInvestigateBar
            count={checkedItems.size}
            actionLabel={`Investigate ${checkedItems.size} in new session`}
            onClear={() => setCheckedItems(new Map())}
            secondaryActionLabel={
              checkedItems.size > 1
                ? `Investigate in ${checkedItems.size} new sessions`
                : undefined
            }
            onSecondaryAction={() => handleInvestigateChecked(true)}
            onInvestigate={() => handleInvestigateChecked(false)}
          />
        )}
      </PopoverContent>
      {projectPath && previewTarget && (
        <IssuePreviewModal
          open
          onOpenChange={isOpen => {
            if (!isOpen) setPreviewTarget(null)
          }}
          projectPath={projectPath}
          type={previewTarget.type}
          number={previewTarget.number}
          ghsaId={previewTarget.ghsaId}
        />
      )}
    </Popover>
  )
}
