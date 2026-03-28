import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  memo,
  useMemo,
  useState,
  useCallback,
} from 'react'
import { flushSync } from 'react-dom'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'
import { MessageItem } from './MessageItem'

/** Number of messages to render initially (from the end) */
const INITIAL_VISIBLE_COUNT = 10
/** Number of messages to load when scrolling up */
const LOAD_MORE_COUNT = 20
/** Scroll threshold in pixels to trigger loading more */
const SCROLL_THRESHOLD = 300

export interface VirtualizedMessageListHandle {
  /** Scroll to a specific message by index */
  scrollToIndex: (
    index: number,
    options?: { align?: 'start' | 'center' | 'end' }
  ) => void
  /** Check if a message index is currently in the visible range */
  isIndexInView: (index: number) => boolean
  /** Get the current visible range */
  getVisibleRange: () => { start: number; end: number } | null
}

interface VirtualizedMessageListProps {
  /** Messages to render */
  messages: ChatMessage[]
  /** Ref to the scroll container (ScrollArea viewport) */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Total number of messages */
  totalMessages: number
  /** Index of the last message with ExitPlanMode tool */
  lastPlanMessageIndex: number
  /** Current session ID */
  sessionId: string
  /** Worktree path for resolving file mentions */
  worktreePath: string
  /** Keyboard shortcut for approve button */
  approveShortcut: string
  /** Keyboard shortcut for approve yolo button */
  approveShortcutYolo?: string
  /** Keyboard shortcut to display on clear context button */
  approveShortcutClearContext?: string
  /** Keyboard shortcut to display on clear context build button */
  approveShortcutClearContextBuild?: string
  /** Ref for approve button visibility tracking */
  approveButtonRef?: React.RefObject<HTMLButtonElement | null>
  /** Whether Claude is currently streaming */
  isSending: boolean
  /** Callback when user approves a plan */
  onPlanApproval: (messageId: string) => void
  /** Callback when user approves a plan with yolo mode */
  onPlanApprovalYolo?: (messageId: string) => void
  /** Callback for clear context approval (new session with plan in yolo mode) */
  onClearContextApproval?: (messageId: string) => void
  /** Callback for clear context approval (new session with plan in build mode) */
  onClearContextApprovalBuild?: (messageId: string) => void
  /** Callback for creating new worktree session with build mode */
  onWorktreeBuildApproval?: (messageId: string) => void
  /** Callback for creating new worktree session with yolo mode */
  onWorktreeYoloApproval?: (messageId: string) => void
  /** Callback when user answers a question */
  onQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  /** Callback when user skips a question */
  onQuestionSkip: (toolCallId: string) => void
  /** Callback when user clicks a file path */
  onFileClick: (path: string) => void
  /** Callback when user clicks an edited file badge (opens diff modal) */
  onEditedFileClick: (path: string) => void
  /** Callback when user fixes a finding */
  onFixFinding: (finding: ReviewFinding, suggestion?: string) => Promise<void>
  /** Callback when user fixes all findings */
  onFixAllFindings: (
    findings: { finding: ReviewFinding; suggestion?: string }[]
  ) => Promise<void>
  /** Check if a question has been answered */
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  /** Get submitted answers for a question */
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  /** Check if questions are being skipped for this session */
  areQuestionsSkipped: (sessionId: string) => boolean
  /** Check if a finding has been fixed */
  isFindingFixed: (sessionId: string, key: string) => boolean
  /** Callback to copy a user message back to the input field */
  onCopyToInput?: (message: ChatMessage) => void
  /** Hide approve buttons (e.g. for Codex which has no native approval flow) */
  hideApproveButtons?: boolean
  /** Whether we should scroll to bottom (new message arrived while at bottom) */
  shouldScrollToBottom?: boolean
  /** Callback when scroll-to-bottom is handled */
  onScrollToBottomHandled?: () => void
  /** Duration of last completed run (ms) — shown on last assistant message */
  completedDurationMs?: number | null
}

/**
 * Lazy-loading message list that renders the last N messages initially
 * and loads more when scrolling up. Optimized for fast initial render.
 * Memoized to prevent re-renders when parent re-renders with same props.
 */
export const VirtualizedMessageList = memo(
  forwardRef<VirtualizedMessageListHandle, VirtualizedMessageListProps>(
    function VirtualizedMessageList(
      {
        messages,
        scrollContainerRef,
        totalMessages,
        lastPlanMessageIndex,
        sessionId,
        worktreePath,
        approveShortcut,
        approveShortcutYolo,
        approveShortcutClearContext,
        approveShortcutClearContextBuild,
        approveButtonRef,
        isSending,
        onPlanApproval,
        onPlanApprovalYolo,
        onClearContextApproval,
        onClearContextApprovalBuild,
        onWorktreeBuildApproval,
        onWorktreeYoloApproval,
        onQuestionAnswer,
        onQuestionSkip,
        onFileClick,
        onEditedFileClick,
        onFixFinding,
        onFixAllFindings,
        isQuestionAnswered,
        getSubmittedAnswers,
        areQuestionsSkipped,
        isFindingFixed,
        onCopyToInput,
        hideApproveButtons,
        shouldScrollToBottom,
        onScrollToBottomHandled,
        completedDurationMs,
      },
      ref
    ) {
      const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
      const isLoadingMoreRef = useRef(false)

      // Track how many messages to render (from the end)
      const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)

      // Calculate which messages to render
      const startIndex = Math.max(0, messages.length - visibleCount)
      const visibleMessages = messages.slice(startIndex)
      const hasMoreMessages = startIndex > 0

      // Reset visible count when session changes
      const prevSessionRef = useRef(sessionId)
      useEffect(() => {
        if (sessionId !== prevSessionRef.current) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setVisibleCount(INITIAL_VISIBLE_COUNT)
          prevSessionRef.current = sessionId
        }
      }, [sessionId])

      // Pre-compute hasFollowUpMessage for all messages in O(n) instead of O(n²)
      const hasFollowUpMap = useMemo(() => {
        const map = new Map<number, boolean>()
        let foundUserMessage = false
        for (let i = messages.length - 1; i >= 0; i--) {
          map.set(i, foundUserMessage)
          if (messages[i]?.role === 'user') {
            foundUserMessage = true
          }
        }
        return map
      }, [messages])

      // Load more messages when scrolling near the top.
      // Uses flushSync so state update + DOM commit + scroll correction happen in one task.
      const loadMore = useCallback(() => {
        const container = scrollContainerRef.current
        if (!container || !hasMoreMessages || isLoadingMoreRef.current) return

        isLoadingMoreRef.current = true
        const scrollHeightBefore = container.scrollHeight

        flushSync(() => {
          setVisibleCount(prev =>
            Math.min(prev + LOAD_MORE_COUNT, messages.length)
          )
        })

        container.scrollTop += container.scrollHeight - scrollHeightBefore
        isLoadingMoreRef.current = false
      }, [scrollContainerRef, hasMoreMessages, messages.length])

      // Detect scroll to top
      useEffect(() => {
        const container = scrollContainerRef.current
        if (!container || !hasMoreMessages) return

        const handleScroll = () => {
          if (container.scrollTop < SCROLL_THRESHOLD) {
            loadMore()
          }
        }

        container.addEventListener('scroll', handleScroll, { passive: true })
        return () => container.removeEventListener('scroll', handleScroll)
      }, [scrollContainerRef, hasMoreMessages, loadMore])

      // Expose methods to parent via ref
      useImperativeHandle(ref, () => ({
        scrollToIndex: (
          index: number,
          options?: { align?: 'start' | 'center' | 'end' }
        ) => {
          // If target message isn't rendered yet, expand visibleCount first
          if (index < startIndex) {
            const newVisibleCount = messages.length - index + 10
            setVisibleCount(newVisibleCount)
            requestAnimationFrame(() => {
              const el = messageRefs.current.get(index)
              el?.scrollIntoView({
                behavior: 'smooth',
                block: options?.align ?? 'start',
              })
            })
          } else {
            const el = messageRefs.current.get(index)
            if (el) {
              el.scrollIntoView({
                behavior: 'smooth',
                block: options?.align ?? 'start',
              })
            }
          }
        },
        isIndexInView: (index: number) => {
          const el = messageRefs.current.get(index)
          const container = scrollContainerRef.current
          if (!el || !container) return false
          const rect = el.getBoundingClientRect()
          const containerRect = container.getBoundingClientRect()
          return (
            rect.top < containerRect.bottom && rect.bottom > containerRect.top
          )
        },
        getVisibleRange: () => ({
          start: startIndex,
          end: messages.length - 1,
        }),
      }))

      // Handle scroll-to-bottom when new messages arrive
      const prevMessageCountRef = useRef(messages.length)
      useEffect(() => {
        if (
          shouldScrollToBottom &&
          messages.length > prevMessageCountRef.current
        ) {
          const lastEl = messageRefs.current.get(messages.length - 1)
          if (lastEl) {
            lastEl.scrollIntoView({ behavior: 'instant', block: 'end' })
            onScrollToBottomHandled?.()
          }
        }
        prevMessageCountRef.current = messages.length
      }, [messages.length, shouldScrollToBottom, onScrollToBottomHandled])

      if (messages.length === 0) return null

      return (
        <div className="flex flex-col w-full">
          {hasMoreMessages && (
            <button
              type="button"
              onClick={loadMore}
              className="w-full text-center text-muted-foreground text-xs py-2 opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
            >
              ↑ Load more ({startIndex} older messages)
            </button>
          )}

          {visibleMessages.map((message, localIndex) => {
            const globalIndex = startIndex + localIndex
            const hasFollowUpMessage =
              message.role === 'assistant' &&
              (hasFollowUpMap.get(globalIndex) ?? false)

            // Show completed duration on the last assistant message (from store),
            // or fall back to timestamp-based computation for persisted messages (after reload)
            let durationMs: number | null = null
            if (
              message.role === 'assistant' &&
              globalIndex === messages.length - 1 &&
              completedDurationMs
            ) {
              durationMs = completedDurationMs
            } else if (message.role === 'assistant' && globalIndex > 0) {
              const prevMessage = messages[globalIndex - 1]
              if (prevMessage?.role === 'user') {
                const deltaSecs = message.timestamp - prevMessage.timestamp
                if (deltaSecs > 0 && deltaSecs < 3600)
                  durationMs = deltaSecs * 1000
              }
            }

            return (
              <div
                key={message.id}
                ref={el => {
                  if (el) messageRefs.current.set(globalIndex, el)
                  else messageRefs.current.delete(globalIndex)
                }}
                className={
                  globalIndex === messages.length - 1 && isSending ? '' : 'pb-4'
                }
              >
                <MessageItem
                  message={message}
                  messageIndex={globalIndex}
                  totalMessages={totalMessages}
                  lastPlanMessageIndex={lastPlanMessageIndex}
                  hasFollowUpMessage={hasFollowUpMessage}
                  sessionId={sessionId}
                  worktreePath={worktreePath}
                  approveShortcut={approveShortcut}
                  approveShortcutYolo={approveShortcutYolo}
                  approveShortcutClearContext={approveShortcutClearContext}
                  approveShortcutClearContextBuild={
                    approveShortcutClearContextBuild
                  }
                  approveButtonRef={
                    globalIndex === lastPlanMessageIndex
                      ? approveButtonRef
                      : undefined
                  }
                  isSending={isSending}
                  onPlanApproval={onPlanApproval}
                  onPlanApprovalYolo={onPlanApprovalYolo}
                  onClearContextApproval={onClearContextApproval}
                  onClearContextApprovalBuild={onClearContextApprovalBuild}
                  onWorktreeBuildApproval={onWorktreeBuildApproval}
                  onWorktreeYoloApproval={onWorktreeYoloApproval}
                  onQuestionAnswer={onQuestionAnswer}
                  onQuestionSkip={onQuestionSkip}
                  onFileClick={onFileClick}
                  onEditedFileClick={onEditedFileClick}
                  onFixFinding={onFixFinding}
                  onFixAllFindings={onFixAllFindings}
                  isQuestionAnswered={isQuestionAnswered}
                  getSubmittedAnswers={getSubmittedAnswers}
                  areQuestionsSkipped={areQuestionsSkipped}
                  isFindingFixed={isFindingFixed}
                  onCopyToInput={onCopyToInput}
                  hideApproveButtons={hideApproveButtons}
                  durationMs={durationMs}
                />
              </div>
            )
          })}
        </div>
      )
    }
  )
)
