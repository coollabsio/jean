import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  memo,
  useState,
  useCallback,
} from 'react'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'
import { MessageItem } from './MessageItem'

/** Number of messages to render initially (from the end) */
const INITIAL_VISIBLE_COUNT = 50
/** Number of messages to load when scrolling up */
const LOAD_MORE_COUNT = 50
/** Scroll threshold in pixels to trigger loading more */
const SCROLL_THRESHOLD = 200

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
  /** Pre-computed map of hasFollowUpMessage for each message index */
  hasFollowUpMap: Map<number, boolean>
  /** Current session ID */
  sessionId: string
  /** Worktree path for resolving file mentions */
  worktreePath: string
  /** Keyboard shortcut for approve button */
  approveShortcut: string
  /** Ref for approve button visibility tracking */
  approveButtonRef?: React.RefObject<HTMLButtonElement | null>
  /** Whether Claude is currently streaming */
  isSending: boolean
  /** Callback when user approves a plan */
  onPlanApproval: (messageId: string) => void
  /** Callback when user approves a plan with yolo mode */
  onPlanApprovalYolo?: (messageId: string) => void
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
  /** Whether we should scroll to bottom (new message arrived while at bottom) */
  shouldScrollToBottom?: boolean
  /** Callback when scroll-to-bottom is handled */
  onScrollToBottomHandled?: () => void
  /** Callback when user wants to fork conversation from a message */
  onFork?: (messageId: string) => void
  /** Callback when user wants to revert conversation to a message */
  onRevert?: (messageId: string) => void
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
        hasFollowUpMap,
        sessionId,
        worktreePath,
        approveShortcut,
        approveButtonRef,
        isSending,
        onPlanApproval,
        onPlanApprovalYolo,
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
        shouldScrollToBottom,
        onScrollToBottomHandled,
        onFork,
        onRevert,
      },
      ref
    ) {
      const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map())

      // Track how many messages to render (from the end)
      const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)

      // Calculate which messages to render
      const startIndex = Math.max(0, messages.length - visibleCount)
      const visibleMessages = messages.slice(startIndex)
      const hasMoreMessages = startIndex > 0

      // Reset visible count when session changes (messages go to 0)
      const prevSessionRef = useRef(sessionId)
      useEffect(() => {
        if (sessionId !== prevSessionRef.current) {
          setVisibleCount(INITIAL_VISIBLE_COUNT)
          prevSessionRef.current = sessionId
        }
      }, [sessionId])

      // Load more messages when scrolling near the top
      const loadMore = useCallback(() => {
        const container = scrollContainerRef.current
        if (!container || !hasMoreMessages) return

        // Preserve scroll position when prepending
        const scrollHeightBefore = container.scrollHeight

        setVisibleCount(prev =>
          Math.min(prev + LOAD_MORE_COUNT, messages.length)
        )

        // After render, adjust scroll to maintain position
        requestAnimationFrame(() => {
          const scrollHeightAfter = container.scrollHeight
          container.scrollTop += scrollHeightAfter - scrollHeightBefore
        })
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
            const newVisibleCount = messages.length - index + 10 // Load up to target + buffer
            setVisibleCount(newVisibleCount)
            // Scroll after render
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
        getVisibleRange: () => {
          return { start: startIndex, end: messages.length - 1 }
        },
      }))

      // Handle scroll-to-bottom when new messages arrive
      const prevMessageCountRef = useRef(messages.length)
      useEffect(() => {
        if (
          shouldScrollToBottom &&
          messages.length > prevMessageCountRef.current
        ) {
          // New message arrived while we should scroll to bottom
          const lastEl = messageRefs.current.get(messages.length - 1)
          if (lastEl) {
            lastEl.scrollIntoView({ behavior: 'smooth', block: 'end' })
          }
          onScrollToBottomHandled?.()
        }
        prevMessageCountRef.current = messages.length
      }, [messages.length, shouldScrollToBottom, onScrollToBottomHandled])

      // Early return if no messages
      if (messages.length === 0) {
        return null
      }

      return (
        <div className="flex flex-col w-full">
          {/* Show indicator when more messages exist */}
          {hasMoreMessages && (
            <div className="text-center text-muted-foreground text-xs py-2 opacity-60">
              ↑ {startIndex} older messages
            </div>
          )}

          {visibleMessages.map((message, localIndex) => {
            const globalIndex = startIndex + localIndex
            const hasFollowUpMessage =
              message.role === 'assistant' &&
              (hasFollowUpMap.get(globalIndex) ?? false)

            return (
              <div
                key={message.id}
                ref={el => {
                  if (el) messageRefs.current.set(globalIndex, el)
                  else messageRefs.current.delete(globalIndex)
                }}
                className="pb-4"
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
                  approveButtonRef={
                    globalIndex === lastPlanMessageIndex
                      ? approveButtonRef
                      : undefined
                  }
                  isSending={isSending}
                  onPlanApproval={onPlanApproval}
                  onPlanApprovalYolo={onPlanApprovalYolo}
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
                  onFork={onFork}
                  onRevert={onRevert}
                  canShowActions={
                    message.role === 'assistant' && !isSending
                  }
                />
              </div>
            )
          })}
        </div>
      )
    }
  )
)
