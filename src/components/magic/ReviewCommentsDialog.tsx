import { useCallback, useEffect, useState } from 'react'
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
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useWorktrees } from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { DEFAULT_REVIEW_COMMENTS_PROMPT } from '@/types/preferences'
import type {
  GitHubReviewComment,
  GitHubComment,
  GitHubReview,
  GitHubPullRequestDetail,
} from '@/types/github'

type Phase = 'loading' | 'select'
type CommentTab = 'inline' | 'conversation'

/** Unified conversation item — either a PR comment or a review with body */
type ConversationItem =
  | { kind: 'comment'; data: GitHubComment }
  | { kind: 'review'; data: GitHubReview }

function getCreatedAt(
  obj: { created_at?: string; createdAt?: string } & Record<string, unknown>
): string {
  return (
    ((obj as Record<string, unknown>).createdAt as string) ||
    ((obj as Record<string, unknown>).created_at as string) ||
    ''
  )
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

  // Inline code comments state
  const [comments, setComments] = useState<GitHubReviewComment[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Conversation comments state
  const [conversationItems, setConversationItems] = useState<
    ConversationItem[]
  >([])
  const [conversationSelected, setConversationSelected] = useState<Set<number>>(
    new Set()
  )

  const fetchComments = useCallback(async () => {
    if (!worktreePath || !prNumber) return

    setPhase('loading')
    setError(null)
    setComments([])
    setSelected(new Set())
    setExpanded(new Set())
    setConversationItems([])
    setConversationSelected(new Set())

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

      // Inline code comments
      setComments(inlineResult)
      setSelected(new Set(inlineResult.map((_, i) => i)))

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
      setConversationItems(items)
      setConversationSelected(new Set(items.map((_, i) => i)))

      // Default to whichever tab has content; prefer inline
      if (inlineResult.length === 0 && items.length > 0) {
        setTab('conversation')
      } else {
        setTab('inline')
      }

      setPhase('select')
    } catch (err) {
      setError(String(err))
      setPhase('select')
    }
  }, [worktreePath, prNumber])

  // Fetch when modal opens
  useEffect(() => {
    if (reviewCommentsModalOpen && worktreePath && prNumber) {
      fetchComments()
    }
  }, [reviewCommentsModalOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setPhase('loading')
        setComments([])
        setSelected(new Set())
        setExpanded(new Set())
        setConversationItems([])
        setConversationSelected(new Set())
        setError(null)
        setIsSending(false)
        setTab('inline')
      }
      setReviewCommentsModalOpen(open)
    },
    [setReviewCommentsModalOpen]
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

  // Conversation selection helper
  const toggleConversationSelect = useCallback((index: number) => {
    setConversationSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  // Toggle all for active tab
  const activeItems = tab === 'inline' ? comments : conversationItems
  const activeSelected = tab === 'inline' ? selected : conversationSelected
  const allSelected =
    activeItems.length > 0 && activeSelected.size === activeItems.length

  const toggleAll = useCallback(() => {
    if (tab === 'inline') {
      if (selected.size === comments.length) setSelected(new Set())
      else setSelected(new Set(comments.map((_, i) => i)))
    } else {
      if (conversationSelected.size === conversationItems.length)
        setConversationSelected(new Set())
      else setConversationSelected(new Set(conversationItems.map((_, i) => i)))
    }
  }, [
    tab,
    selected.size,
    comments.length,
    conversationSelected.size,
    conversationItems.length,
  ])

  const handleSendToChat = useCallback(() => {
    if (!prNumber) return

    const currentSelected = tab === 'inline' ? selected : conversationSelected
    if (currentSelected.size === 0) return

    setIsSending(true)

    let formattedComments: string

    if (tab === 'inline') {
      formattedComments = comments
        .filter((_, i) => selected.has(i))
        .map(c => {
          const lineInfo = c.line ? `:${c.line}` : ''
          return `### File: ${c.path}${lineInfo}
**@${c.author.login}** (${c.createdAt}):
${c.body}

\`\`\`diff
${c.diffHunk}
\`\`\``
        })
        .join('\n\n---\n\n')
    } else {
      formattedComments = conversationItems
        .filter((_, i) => conversationSelected.has(i))
        .map(item => {
          if (item.kind === 'review') {
            const r = item.data
            const date = r.submittedAt ?? ''
            return `### Review (${reviewStateLabel(r.state)})
**@${r.author.login}** — ${date}:
${r.body}`
          } else {
            const c = item.data
            const date = getCreatedAt(c as unknown as Record<string, unknown>)
            return `### PR Comment
**@${c.author.login}** — ${date}:
${c.body}`
          }
        })
        .join('\n\n---\n\n')
    }

    // Build prompt from magic prompt template
    const customPrompt = preferences?.magic_prompts?.review_comments
    const template =
      customPrompt && customPrompt.trim()
        ? customPrompt
        : DEFAULT_REVIEW_COMMENTS_PROMPT
    const prompt = template
      .replace(/\{prNumber\}/g, String(prNumber))
      .replace(/\{reviewComments\}/g, formattedComments)

    // Close dialog
    setReviewCommentsModalOpen(false)

    // Dispatch to ChatWindow via magic-command event or pending command
    const chatState = useChatStore.getState()
    if (chatState.activeWorktreePath) {
      window.dispatchEvent(
        new CustomEvent('magic-command', {
          detail: { command: 'review-comments', prompt },
        })
      )
    } else {
      const worktreeId = selectedWorktreeId
      if (worktreeId && worktree?.path) {
        useChatStore
          .getState()
          .setPendingMagicCommand({ command: 'review-comments', prompt })
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
    }
  }, [
    tab,
    selected,
    comments,
    conversationSelected,
    conversationItems,
    prNumber,
    preferences?.magic_prompts?.review_comments,
    setReviewCommentsModalOpen,
    selectedWorktreeId,
    worktree?.path,
  ])

  const hasAnyComments = comments.length > 0 || conversationItems.length > 0

  return (
    <Dialog open={reviewCommentsModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[95vw] h-[90vh] max-w-none sm:max-w-none flex flex-col">
        <DialogHeader>
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
            <div className="flex gap-1 px-1">
              <Button
                variant={tab === 'inline' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => setTab('inline')}
              >
                <Code className="size-3" />
                Code Comments ({comments.length})
              </Button>
              <Button
                variant={tab === 'conversation' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => setTab('conversation')}
              >
                <MessagesSquare className="size-3" />
                Conversation ({conversationItems.length})
              </Button>
            </div>

            {/* Selection controls */}
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs text-muted-foreground">
                {activeSelected.size} of {activeItems.length} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={toggleAll}
              >
                {allSelected ? 'Deselect All' : 'Select All'}
              </Button>
            </div>

            {/* Inline code comments tab */}
            {tab === 'inline' && comments.length > 0 && (
              <ScrollArea className="flex-1 min-h-0 border rounded-md">
                <div className="divide-y">
                  {comments.map((comment, index) => {
                    const isExpanded = expanded.has(index)
                    const lineInfo = comment.line ? `:${comment.line}` : ''

                    return (
                      <div key={index} className="px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={selected.has(index)}
                            onCheckedChange={() => toggleSelect(index)}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-xs">
                              <code className="font-mono text-foreground truncate">
                                {comment.path}
                                {lineInfo}
                              </code>
                              <span className="text-muted-foreground shrink-0">
                                @{comment.author.login}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-foreground/90 whitespace-pre-wrap">
                              {comment.body}
                            </p>
                            <button
                              className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => toggleExpand(index)}
                            >
                              {isExpanded ? (
                                <ChevronDown className="size-3" />
                              ) : (
                                <ChevronRight className="size-3" />
                              )}
                              Diff context
                            </button>
                            {isExpanded && (
                              <pre className="mt-1.5 p-2 text-xs font-mono bg-muted rounded overflow-x-auto max-h-40">
                                {comment.diffHunk}
                              </pre>
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
            {tab === 'inline' && comments.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 flex-1">
                <Code className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No inline code comments on this PR
                </p>
              </div>
            )}

            {/* Conversation tab */}
            {tab === 'conversation' && conversationItems.length > 0 && (
              <ScrollArea className="flex-1 min-h-0 border rounded-md">
                <div className="divide-y">
                  {conversationItems.map((item, index) => (
                    <div key={index} className="px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={conversationSelected.has(index)}
                          onCheckedChange={() =>
                            toggleConversationSelect(index)
                          }
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs flex-wrap">
                            <span className="text-muted-foreground shrink-0">
                              @{item.data.author.login}
                            </span>
                            {item.kind === 'review' && (
                              <ReviewStateBadge state={item.data.state} />
                            )}
                            <span className="text-muted-foreground/60 text-[10px]">
                              {item.kind === 'review'
                                ? (item.data.submittedAt ?? '')
                                : getCreatedAt(
                                    item.data as unknown as Record<
                                      string,
                                      unknown
                                    >
                                  )}
                            </span>
                          </div>
                          <p className="mt-1 text-sm text-foreground/90 whitespace-pre-wrap">
                            {item.data.body}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
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
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={activeSelected.size === 0 || isSending}
                onClick={handleSendToChat}
              >
                {isSending ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <MessageSquare className="size-3.5 mr-1.5" />
                )}
                Send to Chat ({activeSelected.size})
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
