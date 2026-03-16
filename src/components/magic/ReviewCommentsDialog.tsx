import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@/lib/transport'
import {
  Loader2,
  MessageSquare,
  RefreshCw,
  ChevronDown,
  ChevronRight,
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
import type { GitHubReviewComment } from '@/types/github'

type Phase = 'loading' | 'select'

export function ReviewCommentsDialog() {
  const { reviewCommentsModalOpen, setReviewCommentsModalOpen } = useUIStore()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: preferences } = usePreferences()

  const { data: worktrees } = useWorktrees(selectedProjectId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const worktree = worktrees?.find(w => w.id === selectedWorktreeId) ?? null

  const prNumber = worktree?.pr_number
  const worktreePath = worktree?.path

  // Local state
  const [phase, setPhase] = useState<Phase>('loading')
  const [comments, setComments] = useState<GitHubReviewComment[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  const fetchComments = useCallback(async () => {
    if (!worktreePath || !prNumber) return

    setPhase('loading')
    setError(null)
    setComments([])
    setSelected(new Set())
    setExpanded(new Set())

    try {
      const result = await invoke<GitHubReviewComment[]>(
        'get_pr_review_comments',
        { projectPath: worktreePath, prNumber }
      )
      setComments(result)
      // Select all by default
      setSelected(new Set(result.map((_, i) => i)))
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
        setError(null)
        setIsSending(false)
      }
      setReviewCommentsModalOpen(open)
    },
    [setReviewCommentsModalOpen]
  )

  const toggleSelect = useCallback((index: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  const toggleExpand = useCallback((index: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    if (selected.size === comments.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(comments.map((_, i) => i)))
    }
  }, [selected.size, comments.length])

  const handleSendToChat = useCallback(() => {
    if (selected.size === 0 || !prNumber) return

    setIsSending(true)

    // Format selected comments
    const formattedComments = comments
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
      // ChatWindow is mounted — dispatch event directly
      window.dispatchEvent(
        new CustomEvent('magic-command', {
          detail: { command: 'review-comments', prompt },
        })
      )
    } else {
      // Canvas mode — open SessionChatModal (not bare ChatWindow) and set pending command
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
    selected,
    comments,
    prNumber,
    preferences?.magic_prompts?.review_comments,
    setReviewCommentsModalOpen,
    selectedWorktreeId,
    worktree?.path,
  ])

  const allSelected = comments.length > 0 && selected.size === comments.length

  return (
    <Dialog open={reviewCommentsModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[95vw] h-[90vh] max-w-none sm:max-w-none flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="size-4" />
            Review Comments {prNumber ? `#${prNumber}` : ''}
          </DialogTitle>
        </DialogHeader>

        {phase === 'loading' && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading review comments...
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

        {phase === 'select' && !error && comments.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12">
            <MessageSquare className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No inline review comments found on this PR
            </p>
          </div>
        )}

        {phase === 'select' && !error && comments.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs text-muted-foreground">
                {selected.size} of {comments.length} selected
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
                              {comment.path}{lineInfo}
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
                disabled={selected.size === 0 || isSending}
                onClick={handleSendToChat}
              >
                {isSending ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <MessageSquare className="size-3.5 mr-1.5" />
                )}
                Send to Chat ({selected.size})
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
