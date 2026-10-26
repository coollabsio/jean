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
  RefreshCw,
  Wand2,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
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
  type ContextMentionType,
  useContextMentionData,
} from './hooks/useContextMentionData'

const githubContextQueries = new Set([
  'issues',
  'prs',
  'issue-search',
  'pr-search',
  'issue-by-number',
  'pr-by-number',
  'discussions',
  'discussion-search',
  'discussion',
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
type ContextMentionTab = ContextMentionType | 'all'

const tabLabels: Record<ContextMentionTab, string> = {
  all: 'All',
  issue: 'Issues',
  pr: 'PRs',
  discussion: 'Discussions',
  security: 'Security',
  advisory: 'Advisories',
  linear: 'Linear',
}

const loadMoreLabels: Partial<Record<ContextMentionType, string>> = {
  issue: 'issues',
  pr: 'pull requests',
  discussion: 'discussions',
}
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
  if (item.discussion) return { type: 'discussion', id: item.discussion.number }
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
    'inline-flex shrink-0 items-center justify-center self-center rounded text-foreground/80 transition-colors hover:bg-muted hover:text-foreground',
    isMobile ? 'size-8' : 'size-6'
  )
  const [includeClosed, setIncludeClosed] = useState(false)
  const [menuSearch, setMenuSearch] = useState('')
  const [activeTab, setActiveTab] = useState<ContextMentionTab>('all')
  const [, setLimitsVersion] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null)
  // Keyed by item id; kept across searches so items from several searches
  // can be investigated together
  const [checkedItems, setCheckedItems] = useState<
    Map<string, ContextMentionItem>
  >(() => new Map())
  const query = menuSearch || searchQuery
  const limitKey = (group: ContextMentionType) =>
    `${limitKeyPrefix(projectPath, projectId)}${includeClosed}\0${group}\0${query}`
  const limitFor = (group: ContextMentionType) =>
    loadedLimits.get(limitKey(group)) ?? DEFAULT_LIST_LIMIT
  const { groups, isFetching, loadMoreDiscussions } = useContextMentionData({
    open,
    projectPath,
    projectId,
    query,
    includeClosed,
    issueLimit: limitFor('issue'),
    prLimit: limitFor('pr'),
    discussionLimit: limitFor('discussion'),
  })
  const loadMore = (group: ContextMentionType) => {
    const limit = limitFor(group) + DEFAULT_LIST_LIMIT
    loadedLimits.set(limitKey(group), limit)
    setLimitsVersion(version => version + 1)
    if (group === 'discussion') loadMoreDiscussions(limit)
  }
  const { getMatches, currentWorktreeId } = useContextLinkUsage({
    enabled: open,
    projectId,
    projectPath,
    currentSessionId: sessionId,
  })
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Tabs narrow the list to one section. Search always covers every
  // section: typing switches back to "All".
  const currentTab = groups.some(group => group.id === activeTab)
    ? activeTab
    : 'all'
  const visibleGroups = useMemo(
    () =>
      currentTab === 'all'
        ? groups
        : groups.filter(group => group.id === currentTab),
    [currentTab, groups]
  )
  const flatItems = useMemo(
    () => visibleGroups.flatMap(group => group.items),
    [visibleGroups]
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
    setActiveTab('all')
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
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Refresh context links"
                  disabled={isRefreshing || (!projectPath && !projectId)}
                  onClick={() => void handleRefresh()}
                  className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn('size-4', isRefreshing && 'animate-spin')}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>Refresh context links</TooltipContent>
            </Tooltip>
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
        {groups.length > 1 && (
          <div
            role="tablist"
            aria-label="Context link sections"
            className="flex gap-1 overflow-x-auto border-b px-2 py-1.5"
          >
            {(['all', ...groups.map(group => group.id)] as const).map(tab => {
              const tabGroup =
                tab === 'all' ? null : groups.find(group => group.id === tab)
              const isActive = tab === currentTab
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    setActiveTab(tab)
                    resetListPosition()
                  }}
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {tabLabels[tab]}
                  {tabGroup && (
                    <span className="tabular-nums opacity-70">
                      {tabGroup.items.length}
                      {tabGroup.hasMore ? '+' : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <Command label="Search issues and context links" shouldFilter={false}>
          <CommandInput
            placeholder="Search all sections..."
            value={menuSearch}
            onValueChange={value => {
              setMenuSearch(value)
              setActiveTab('all')
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
              visibleGroups.map(group => (
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
                        {preview && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label={`Preview ${item.label}`}
                                className={actionButtonClass}
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
                        {(item.type === 'issue' || item.type === 'pr') && (
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
                                  <Wand2 className="size-3" />
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
                        )}
                      </CommandItem>
                    )
                  })}
                  {group.hasMore && loadMoreLabels[group.id] && (
                    <div className="flex justify-center px-2 py-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => loadMore(group.id)}
                      >
                        Load more {loadMoreLabels[group.id]}
                      </Button>
                    </div>
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
