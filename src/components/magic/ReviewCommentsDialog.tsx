import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { invoke } from '@/lib/transport'
import {
  Loader2,
  MessageSquare,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Code,
  MessagesSquare,
  CheckCircle2,
  XCircle,
  MessageCircle,
  CalendarClock,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useWorktrees } from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import {
  DEFAULT_MAGIC_PROMPT_MODES,
  DEFAULT_REVIEW_COMMENTS_PROMPT,
} from '@/types/preferences'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import type {
  GitHubReviewComment,
  GitHubComment,
  GitHubReview,
  GitHubPullRequestDetail,
} from '@/types/github'

type Phase = 'loading' | 'select'
type CommentTab = 'inline' | 'conversation'
/** Default shows only open (non-resolved, non-outdated) inline review threads. */
type InlineCommentFilter = 'open' | 'all'

function isOpenReviewComment(comment: GitHubReviewComment): boolean {
  return !comment.isOutdated && !comment.isResolved
}

/** Unified conversation item — either a PR comment or a review with body */
type ConversationItem =
  | { kind: 'comment'; data: GitHubComment }
  | { kind: 'review'; data: GitHubReview }

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable
  )
}

function getCreatedAt(
  obj: { created_at?: string; createdAt?: string } & Record<string, unknown>
): string {
  return (
    ((obj as Record<string, unknown>).createdAt as string) ||
    ((obj as Record<string, unknown>).created_at as string) ||
    ''
  )
}

function getDateMs(dateStr: string): number {
  const ms = new Date(dateStr).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function formatCommentDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getConversationItemDate(item: ConversationItem): string {
  return item.kind === 'review'
    ? (item.data.submittedAt ?? '')
    : getCreatedAt(item.data as unknown as Record<string, unknown>)
}

function sortByNewestDate<T>(items: T[], getDate: (item: T) => string): T[] {
  return [...items].sort(
    (a, b) => getDateMs(getDate(b)) - getDateMs(getDate(a))
  )
}

function previewLine(body: string): string {
  const firstLine =
    body
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? ''
  return firstLine
    .replace(/^#+\s*/, '')
    .replace(/^>+\s*/, '')
    .replace(/^[-*+]\s+/, '')
}

function renderInlineMarkdown(line: string): ReactNode[] {
  // Tokenize for **bold**, *italic* / _italic_, `code`. Emojis/text untouched.
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`)/g
  const parts = line.split(pattern).filter(p => p !== '')
  const seen = new Map<string, number>()
  return parts.map(part => {
    const baseKey = part
    const n = seen.get(baseKey) ?? 0
    seen.set(baseKey, n + 1)
    const key = n === 0 ? baseKey : `${baseKey}#${n}`

    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      )
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      )
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 text-[0.875em] font-mono"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={key}>{part}</span>
  })
}

function reviewStateLabel(state: string): string {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes Requested'
    case 'COMMENTED':
      return 'Commented'
    case 'DISMISSED':
      return 'Dismissed'
    case 'PENDING':
      return 'Pending'
    default:
      return state
  }
}

function formatInlineReviewComment(c: GitHubReviewComment): string {
  const lineInfo = c.line ? `:${c.line}` : ''
  return `### File: ${c.path}${lineInfo}
**@${c.author.login}** (${c.createdAt}):
${c.body}

\`\`\`diff
${c.diffHunk}
\`\`\``
}

function formatConversationReviewItem(item: ConversationItem): string {
  if (item.kind === 'review') {
    const r = item.data
    const date = r.submittedAt ?? ''
    return `### Review (${reviewStateLabel(r.state)})
**@${r.author.login}** — ${date}:
${r.body}`
  }

  const c = item.data
  const date = getCreatedAt(c as unknown as Record<string, unknown>)
  return `### PR Comment
**@${c.author.login}** — ${date}:
${c.body}`
}

function ReviewStateBadge({ state }: { state: string }) {
  const upper = state.toUpperCase()
  const isApproved = upper === 'APPROVED'
  const isChangesRequested = upper === 'CHANGES_REQUESTED'

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
        isApproved
          ? 'bg-green-500/15 text-green-600 dark:text-green-400'
          : isChangesRequested
            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {isApproved ? (
        <CheckCircle2 className="size-2.5" />
      ) : isChangesRequested ? (
        <XCircle className="size-2.5" />
      ) : (
        <MessageCircle className="size-2.5" />
      )}
      {reviewStateLabel(state)}
    </span>
  )
}

export function ReviewCommentsDialog() {
  const { reviewCommentsModalOpen, setReviewCommentsModalOpen } = useUIStore()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: preferences } = usePreferences()

  const { data: worktrees } = useWorktrees(selectedProjectId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const worktree = worktrees?.find(w => w.id === selectedWorktreeId) ?? null

  const prNumber = worktree?.pr_number
  const worktreePath = worktree?.path

  // Shared state
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [tab, setTab] = useState<CommentTab>('inline')
  const [activeIndex, setActiveIndex] = useState(0)
  const activeRowRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Inline code comments state
  const [comments, setComments] = useState<GitHubReviewComment[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [diffExpanded, setDiffExpanded] = useState<Set<number>>(new Set())
  const [inlineFilter, setInlineFilter] =
    useState<InlineCommentFilter>('open')

  // Conversation comments state
  const [conversationItems, setConversationItems] = useState<
    ConversationItem[]
  >([])
  const [conversationSelected, setConversationSelected] = useState<Set<number>>(
    new Set()
  )
  const [conversationExpanded, setConversationExpanded] = useState<Set<number>>(
    new Set()
  )

  const resetTransientState = useCallback(() => {
    setPhase('loading')
    setError(null)
    setIsSending(false)
    setComments([])
    setSelected(new Set())
    setExpanded(new Set())
    setDiffExpanded(new Set())
    setInlineFilter('open')
    setActiveIndex(0)
    setConversationItems([])
    setConversationSelected(new Set())
    setConversationExpanded(new Set())
  }, [])

  const fetchComments = useCallback(async () => {
    if (!worktreePath || !prNumber) return

    resetTransientState()

    try {
      const [inlineResult, prDetail] = await Promise.all([
        invoke<GitHubReviewComment[]>('get_pr_review_comments', {
          projectPath: worktreePath,
          prNumber,
        }),
        invoke<GitHubPullRequestDetail>('get_github_pr', {
          projectPath: worktreePath,
          prNumber,
        }),
      ])

      // Inline code comments (open + resolved/outdated; UI filters open by default)
      const sortedInlineComments = sortByNewestDate(
        inlineResult,
        comment => comment.createdAt
      )
      setComments(sortedInlineComments)
      // Pre-select only open threads — resolved/outdated stay unselected
      setSelected(
        new Set(
          sortedInlineComments.flatMap((comment, i) =>
            isOpenReviewComment(comment) ? [i] : []
          )
        )
      )

      // Build conversation items: PR comments + non-empty review bodies
      const items: ConversationItem[] = []
      for (const c of prDetail.comments ?? []) {
        items.push({ kind: 'comment', data: c })
      }
      for (const r of prDetail.reviews ?? []) {
        if (r.body?.trim()) {
          items.push({ kind: 'review', data: r })
        }
      }
      const sortedConversationItems = sortByNewestDate(
        items,
        getConversationItemDate
      )
      setConversationItems(sortedConversationItems)
      setConversationSelected(new Set(sortedConversationItems.map((_, i) => i)))

      // Default to whichever tab has content; prefer inline
      if (sortedInlineComments.length === 0 && items.length > 0) {
        setTab('conversation')
      } else {
        setTab('inline')
      }
      setActiveIndex(0)

      setPhase('select')
    } catch (err) {
      setError(String(err))
      setPhase('select')
    }
  }, [worktreePath, prNumber, resetTransientState])

  // Fetch when modal opens
  useEffect(() => {
    if (reviewCommentsModalOpen && worktreePath && prNumber) {
      fetchComments()
    }
  }, [reviewCommentsModalOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        resetTransientState()
        setTab('inline')
        setActiveIndex(0)
      }
      setReviewCommentsModalOpen(open)
    },
    [resetTransientState, setReviewCommentsModalOpen]
  )

  // Inline selection helpers
  const toggleSelect = useCallback((index: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const toggleExpand = useCallback((index: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const toggleDiffExpand = useCallback((index: number) => {
    setDiffExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  // Conversation selection helper
  const toggleConversationSelect = useCallback((index: number) => {
    setConversationSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const toggleConversationExpand = useCallback((index: number) => {
    setConversationExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  // Filtered inline list — open by default, with optional All view
  const openInlineCount = useMemo(
    () => comments.filter(isOpenReviewComment).length,
    [comments]
  )
  const filteredInlineEntries = useMemo(() => {
    return comments.flatMap((comment, index) =>
      inlineFilter === 'all' || isOpenReviewComment(comment)
        ? [{ comment, index }]
        : []
    )
  }, [comments, inlineFilter])
  const filteredInlineIndexes = useMemo(
    () => filteredInlineEntries.map(entry => entry.index),
    [filteredInlineEntries]
  )
  const filteredInlineSelectedCount = useMemo(
    () => filteredInlineIndexes.filter(index => selected.has(index)).length,
    [filteredInlineIndexes, selected]
  )

  // Toggle all for active tab (operates on currently visible items)
  const activeItemsLength =
    tab === 'inline' ? filteredInlineEntries.length : conversationItems.length
  const activeSelectedCount =
    tab === 'inline' ? filteredInlineSelectedCount : conversationSelected.size
  const allSelected =
    activeItemsLength > 0 && activeSelectedCount === activeItemsLength

  // Clamp during render so filter/list shrinks never leave an out-of-range index
  const safeActiveIndex =
    activeItemsLength === 0 ? 0 : Math.min(activeIndex, activeItemsLength - 1)

  const focusActiveRow = useCallback(
    (index: number) => {
      const row = activeRowRefs.current[`${tab}-${index}`]
      row?.focus({ preventScroll: true })
      row?.scrollIntoView?.({ block: 'nearest' })
    },
    [tab]
  )

  // Reset selection cursor when the visible list identity changes
  useEffect(() => {
    setActiveIndex(0)
    requestAnimationFrame(() => focusActiveRow(0))
  }, [tab, inlineFilter, focusActiveRow])

  const toggleAll = useCallback(() => {
    if (tab === 'inline') {
      const visible = filteredInlineIndexes
      const allVisibleSelected =
        visible.length > 0 && visible.every(index => selected.has(index))
      if (allVisibleSelected) {
        setSelected(prev => {
          const next = new Set(prev)
          for (const index of visible) next.delete(index)
          return next
        })
      } else {
        setSelected(prev => {
          const next = new Set(prev)
          for (const index of visible) next.add(index)
          return next
        })
      }
    } else {
      if (conversationSelected.size === conversationItems.length)
        setConversationSelected(new Set())
      else setConversationSelected(new Set(conversationItems.map((_, i) => i)))
    }
  }, [
    tab,
    filteredInlineIndexes,
    selected,
    conversationSelected.size,
    conversationItems.length,
  ])

  const buildPrompt = useCallback(
    (formattedComments: string) => {
      if (!prNumber) return ''

      const customPrompt = preferences?.magic_prompts?.review_comments
      const template =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : DEFAULT_REVIEW_COMMENTS_PROMPT
      return template
        .replace(/\{prNumber\}/g, String(prNumber))
        .replace(/\{reviewComments\}/g, formattedComments)
    },
    [prNumber, preferences?.magic_prompts?.review_comments]
  )

  const getSelectedFormattedComments = useCallback((): string[] => {
    if (tab === 'inline') {
      // Only send currently visible + selected comments (respects Open/All filter)
      return filteredInlineEntries.flatMap(({ index, comment }) =>
        selected.has(index) ? [formatInlineReviewComment(comment)] : []
      )
    }

    return conversationItems.flatMap((item, i) =>
      conversationSelected.has(i) ? [formatConversationReviewItem(item)] : []
    )
  }, [
    tab,
    filteredInlineEntries,
    selected,
    conversationItems,
    conversationSelected,
  ])

  const reviewCommentsExecutionMode =
    preferences?.magic_prompt_modes?.review_comments_mode ??
    DEFAULT_MAGIC_PROMPT_MODES.review_comments_mode

  const dispatchReviewCommentsPrompts = useCallback(
    (detail: {
      prompt?: string
      prompts?: string[]
      executionMode?: 'plan' | 'build' | 'yolo'
    }) => {
      setIsSending(false)
      setReviewCommentsModalOpen(false)

      const chatState = useChatStore.getState()
      if (chatState.activeWorktreePath) {
        window.dispatchEvent(
          new CustomEvent('magic-command', {
            detail: { command: 'review-comments', ...detail },
          })
        )
        return
      }

      const worktreeId = selectedWorktreeId
      if (worktreeId && worktree?.path) {
        useChatStore
          .getState()
          .setPendingMagicCommand({ command: 'review-comments', ...detail })
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: {
              worktreeId,
              worktreePath: worktree.path,
              sessionId: '',
            },
          })
        )
      }
    },
    [selectedWorktreeId, setReviewCommentsModalOpen, worktree?.path]
  )

  const handleSendToChat = useCallback(() => {
    if (!prNumber) return

    const formatted = getSelectedFormattedComments()
    if (formatted.length === 0) return

    setIsSending(true)
    dispatchReviewCommentsPrompts({
      prompt: buildPrompt(formatted.join('\n\n---\n\n')),
      executionMode: reviewCommentsExecutionMode,
    })
  }, [
    prNumber,
    getSelectedFormattedComments,
    dispatchReviewCommentsPrompts,
    buildPrompt,
    reviewCommentsExecutionMode,
  ])

  const handleSendSeparately = useCallback(() => {
    if (!prNumber) return

    const formatted = getSelectedFormattedComments()
    if (formatted.length === 0) return

    setIsSending(true)
    dispatchReviewCommentsPrompts({
      prompts: formatted.map(buildPrompt),
      executionMode: reviewCommentsExecutionMode,
    })
  }, [
    prNumber,
    getSelectedFormattedComments,
    dispatchReviewCommentsPrompts,
    buildPrompt,
    reviewCommentsExecutionMode,
  ])

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isEditableTarget(event.target) || phase !== 'select' || error) return

      const sendShortcut =
        event.key === 'Enter' && (event.metaKey || event.ctrlKey)
      if (sendShortcut) {
        event.preventDefault()
        if (event.shiftKey) {
          handleSendToChat()
        } else {
          handleSendSeparately()
        }
        return
      }

      if (activeItemsLength === 0) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const next = Math.min(safeActiveIndex + 1, activeItemsLength - 1)
        setActiveIndex(next)
        requestAnimationFrame(() => focusActiveRow(next))
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const next = Math.max(safeActiveIndex - 1, 0)
        setActiveIndex(next)
        requestAnimationFrame(() => focusActiveRow(next))
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        if (tab === 'inline') {
          const originalIndex = filteredInlineEntries[safeActiveIndex]?.index
          if (originalIndex !== undefined) toggleExpand(originalIndex)
        } else {
          toggleConversationExpand(safeActiveIndex)
        }
        return
      }

      if (event.key === ' ') {
        event.preventDefault()
        if (tab === 'inline') {
          const originalIndex = filteredInlineEntries[safeActiveIndex]?.index
          if (originalIndex !== undefined) toggleSelect(originalIndex)
        } else {
          toggleConversationSelect(safeActiveIndex)
        }
      }
    },
    [
      safeActiveIndex,
      activeItemsLength,
      focusActiveRow,
      error,
      filteredInlineEntries,
      handleSendSeparately,
      handleSendToChat,
      phase,
      tab,
      toggleConversationExpand,
      toggleConversationSelect,
      toggleExpand,
      toggleSelect,
    ]
  )

  const hasAnyComments = comments.length > 0 || conversationItems.length > 0

  return (
    <Dialog open={reviewCommentsModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        onKeyDown={handleDialogKeyDown}
        className="!fixed !inset-0 !translate-x-0 !translate-y-0 !w-screen !h-dvh !max-w-screen !max-h-none !rounded-none flex flex-col overflow-hidden sm:!inset-auto sm:!top-[50%] sm:!left-[50%] sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!w-[95vw] sm:!h-[90vh] sm:!max-w-none sm:!rounded-lg"
      >
        <DialogHeader className="pr-10 sm:pr-0">
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="size-4" />
            PR Comments {prNumber ? `#${prNumber}` : ''}
          </DialogTitle>
        </DialogHeader>

        {phase === 'loading' && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading comments...
            </span>
          </div>
        )}

        {phase === 'select' && error && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchComments}>
              <RefreshCw className="size-3.5 mr-1.5" />
              Retry
            </Button>
          </div>
        )}

        {phase === 'select' && !error && !hasAnyComments && (
          <div className="flex flex-col items-center justify-center gap-2 py-12">
            <MessageSquare className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No comments found on this PR
            </p>
          </div>
        )}

        {phase === 'select' && !error && hasAnyComments && (
          <>
            {/* Tab toggle */}
            <div className="flex flex-wrap gap-1 px-1">
              <Button
                variant={tab === 'inline' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => {
                  setTab('inline')
                  setActiveIndex(0)
                }}
              >
                <Code className="size-3" />
                Code Comments (
                {inlineFilter === 'open'
                  ? openInlineCount
                  : comments.length}
                {inlineFilter === 'open' &&
                openInlineCount !== comments.length
                  ? ` open`
                  : ''}
                )
              </Button>
              <Button
                variant={tab === 'conversation' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => {
                  setTab('conversation')
                  setActiveIndex(0)
                }}
              >
                <MessagesSquare className="size-3" />
                Conversation ({conversationItems.length})
              </Button>
            </div>

            {/* Selection controls */}
            <div className="flex items-center justify-between gap-3 px-1 pb-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {activeSelectedCount} of {activeItemsLength} selected
                </span>
                <span className="hidden items-center gap-1 sm:inline-flex">
                  <Kbd className="h-4 min-w-0 px-1 text-[10px]">↑/↓</Kbd>
                  move
                </span>
                <span className="hidden items-center gap-1 sm:inline-flex">
                  <Kbd className="h-4 min-w-0 px-1 text-[10px]">↵</Kbd>
                  expand
                </span>
                <span className="hidden items-center gap-1 sm:inline-flex">
                  <Kbd className="h-4 min-w-0 px-1 text-[10px]">Space</Kbd>
                  select
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {tab === 'inline' && comments.length > 0 && (
                  <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                    <Button
                      variant={inlineFilter === 'open' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setInlineFilter('open')}
                      data-testid="review-filter-open"
                    >
                      Open ({openInlineCount})
                    </Button>
                    <Button
                      variant={inlineFilter === 'all' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setInlineFilter('all')}
                      data-testid="review-filter-all"
                    >
                      All ({comments.length})
                    </Button>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-xs"
                  onClick={toggleAll}
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
            </div>

            {/* Inline code comments tab */}
            {tab === 'inline' && filteredInlineEntries.length > 0 && (
              <ScrollArea className="flex-1 min-h-0 border rounded-md">
                <div className="divide-y">
                  {filteredInlineEntries.map(({ comment, index }, rowIndex) => {
                    const isExpanded = expanded.has(index)
                    const isDiffExpanded = diffExpanded.has(index)
                    const lineInfo = comment.line ? `:${comment.line}` : ''
                    const date = formatCommentDate(comment.createdAt)
                    const preview = previewLine(comment.body)
                    const isActive = safeActiveIndex === rowIndex

                    return (
                      <div
                        key={index}
                        ref={node => {
                          activeRowRefs.current[`inline-${rowIndex}`] = node
                        }}
                        data-active={isActive}
                        data-testid={`review-comment-row-inline-${rowIndex}`}
                        className={cn(
                          'px-3 py-2.5 outline-none transition-colors',
                          isActive && 'bg-accent/40 ring-1 ring-ring/50'
                        )}
                        onClick={() => {
                          setActiveIndex(rowIndex)
                          requestAnimationFrame(() => focusActiveRow(rowIndex))
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={selected.has(index)}
                            onCheckedChange={() => toggleSelect(index)}
                            className="mt-0.5"
                            onClick={e => e.stopPropagation()}
                          />
                          <div className="flex-1 min-w-0">
                            <button
                              type="button"
                              onClick={() => toggleExpand(index)}
                              className="w-full text-left cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {isExpanded ? (
                                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <p className="text-sm text-foreground truncate min-w-0">
                                  {preview ? (
                                    renderInlineMarkdown(preview)
                                  ) : (
                                    <span className="text-muted-foreground italic">
                                      (no body)
                                    </span>
                                  )}
                                </p>
                                {comment.isResolved && (
                                  <span className="inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-500/15 text-green-600 dark:text-green-400">
                                    <CheckCircle2 className="size-2.5" />
                                    Resolved
                                  </span>
                                )}
                                {comment.isOutdated && (
                                  <span className="inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
                                    Outdated
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 pl-5 flex items-center gap-2 text-xs min-w-0">
                                <code className="font-mono text-muted-foreground truncate">
                                  {comment.path}
                                  {lineInfo}
                                </code>
                                <span className="text-muted-foreground/70 shrink-0">
                                  @{comment.author.login}
                                </span>
                                <span className="inline-flex items-center gap-1 text-muted-foreground/60 shrink-0">
                                  <CalendarClock className="size-3" />
                                  {date}
                                </span>
                              </div>
                            </button>
                            {isExpanded && (
                              <div className="mt-2 pl-5">
                                <Markdown compact>{comment.body}</Markdown>
                                <button
                                  type="button"
                                  className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                  onClick={() => toggleDiffExpand(index)}
                                >
                                  {isDiffExpanded ? (
                                    <ChevronDown className="size-3" />
                                  ) : (
                                    <ChevronRight className="size-3" />
                                  )}
                                  Diff context
                                </button>
                                {isDiffExpanded && (
                                  <pre className="mt-1.5 p-2 text-xs font-mono bg-muted rounded overflow-x-auto max-h-40">
                                    {comment.diffHunk}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            )}

            {/* Inline tab empty state */}
            {tab === 'inline' && filteredInlineEntries.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 flex-1">
                <Code className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {comments.length === 0
                    ? 'No inline code comments on this PR'
                    : 'No open review comments — switch to All to see resolved or outdated ones'}
                </p>
                {comments.length > 0 && inlineFilter === 'open' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={() => setInlineFilter('all')}
                  >
                    Show all ({comments.length})
                  </Button>
                )}
              </div>
            )}

            {/* Conversation tab */}
            {tab === 'conversation' && conversationItems.length > 0 && (
              <ScrollArea className="flex-1 min-h-0 border rounded-md">
                <div className="divide-y">
                  {conversationItems.map((item, index) => {
                    const isExpanded = conversationExpanded.has(index)
                    const body = item.data.body ?? ''
                    const preview = previewLine(body)
                    const date = formatCommentDate(
                      getConversationItemDate(item)
                    )

                    const isActive = safeActiveIndex === index
                    const conversationKey =
                      item.kind === 'comment'
                        ? `comment:${item.data.author.login}:${item.data.created_at}:${body.slice(0, 80)}`
                        : `review:${item.data.author.login}:${item.data.submittedAt ?? ''}:${item.data.state}:${body.slice(0, 80)}`

                    return (
                      <div
                        key={conversationKey}
                        ref={node => {
                          activeRowRefs.current[`conversation-${index}`] = node
                        }}
                        data-active={isActive}
                        data-testid={`review-comment-row-conversation-${index}`}
                        className={cn(
                          'px-3 py-2.5 outline-none transition-colors',
                          isActive && 'bg-accent/40 ring-1 ring-ring/50'
                        )}
                        onClick={() => {
                          setActiveIndex(index)
                          requestAnimationFrame(() => focusActiveRow(index))
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={conversationSelected.has(index)}
                            onCheckedChange={() =>
                              toggleConversationSelect(index)
                            }
                            className="mt-0.5"
                            onClick={e => e.stopPropagation()}
                          />
                          <div className="flex-1 min-w-0">
                            <button
                              type="button"
                              onClick={() => toggleConversationExpand(index)}
                              className="w-full text-left cursor-pointer group"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {isExpanded ? (
                                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <p className="text-sm text-foreground truncate min-w-0">
                                  {preview ? (
                                    renderInlineMarkdown(preview)
                                  ) : (
                                    <span className="text-muted-foreground italic">
                                      (no body)
                                    </span>
                                  )}
                                </p>
                              </div>
                              <div className="mt-1 pl-5 flex items-center gap-2 text-xs flex-wrap min-w-0">
                                <span className="text-muted-foreground shrink-0">
                                  @{item.data.author.login}
                                </span>
                                {item.kind === 'review' && (
                                  <ReviewStateBadge state={item.data.state} />
                                )}
                                <span className="inline-flex items-center gap-1 text-muted-foreground/60 text-[10px]">
                                  <CalendarClock className="size-3" />
                                  {date}
                                </span>
                              </div>
                            </button>
                            {isExpanded && (
                              <div className="mt-2 pl-5">
                                <Markdown compact>{body}</Markdown>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            )}

            {/* Conversation tab empty state */}
            {tab === 'conversation' && conversationItems.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 flex-1">
                <MessagesSquare className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No conversation comments on this PR
                </p>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex shrink-0 justify-end gap-2 pt-2 pb-[env(safe-area-inset-bottom)]">
              <Button
                variant="outline"
                size="sm"
                disabled={activeSelectedCount === 0 || isSending}
                onClick={handleSendToChat}
              >
                {isSending ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <MessageSquare className="size-3.5 mr-1.5" />
                )}
                Send to Chat ({activeSelectedCount})
                <KbdGroup className="ml-1.5 hidden sm:inline-flex">
                  <Kbd className="h-4 min-w-4 px-1 text-[10px]">⇧</Kbd>
                  <Kbd className="h-4 min-w-4 px-1 text-[10px]">⌘↵</Kbd>
                </KbdGroup>
              </Button>
              <Button
                size="sm"
                disabled={activeSelectedCount === 0 || isSending}
                onClick={handleSendSeparately}
              >
                {isSending ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <MessagesSquare className="size-3.5 mr-1.5" />
                )}
                Send Separately ({activeSelectedCount})
                <KbdGroup className="ml-1.5 hidden sm:inline-flex">
                  <Kbd className="h-4 min-w-4 px-1 text-[10px]">⌘</Kbd>
                  <Kbd className="h-4 min-w-4 px-1 text-[10px]">↵</Kbd>
                </KbdGroup>
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
