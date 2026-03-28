import { memo, useMemo } from 'react'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'
import { MessageItem } from './MessageItem'

interface MessageListProps {
  messages: ChatMessage[]
  totalMessages: number
  lastPlanMessageIndex: number
  sessionId: string
  worktreePath: string
  approveShortcut: string
  approveShortcutYolo?: string
  approveShortcutClearContext?: string
  approveShortcutClearContextBuild?: string
  approveButtonRef?: React.RefObject<HTMLButtonElement | null>
  isSending: boolean
  onPlanApproval: (messageId: string) => void
  onPlanApprovalYolo?: (messageId: string) => void
  onClearContextApproval?: (messageId: string) => void
  onClearContextApprovalBuild?: (messageId: string) => void
  onWorktreeBuildApproval?: (messageId: string) => void
  onWorktreeYoloApproval?: (messageId: string) => void
  onQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  onQuestionSkip: (toolCallId: string) => void
  onFileClick: (path: string) => void
  onEditedFileClick: (path: string) => void
  onFixFinding: (finding: ReviewFinding, suggestion?: string) => Promise<void>
  onFixAllFindings: (
    findings: { finding: ReviewFinding; suggestion?: string }[]
  ) => Promise<void>
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  areQuestionsSkipped: (sessionId: string) => boolean
  isFindingFixed: (sessionId: string, key: string) => boolean
  onCopyToInput?: (message: ChatMessage) => void
  hideApproveButtons?: boolean
  completedDurationMs?: number | null
}

/**
 * Simple message list that renders all messages.
 * Memoized to prevent re-renders when parent re-renders with same props.
 */
export const MessageList = memo(function MessageList({
  messages,
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
  completedDurationMs,
}: MessageListProps) {
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

  if (messages.length === 0) return null

  return (
    <div className="flex flex-col w-full">
      {messages.map((message, index) => {
        const hasFollowUpMessage =
          message.role === 'assistant' && (hasFollowUpMap.get(index) ?? false)

        // Show completed duration on the last assistant message (from store),
        // or fall back to timestamp-based computation for persisted messages (after reload)
        let durationMs: number | null = null
        if (
          message.role === 'assistant' &&
          index === messages.length - 1 &&
          completedDurationMs
        ) {
          durationMs = completedDurationMs
        } else if (message.role === 'assistant' && index > 0) {
          const prevMessage = messages[index - 1]
          if (prevMessage?.role === 'user') {
            const deltaSecs = message.timestamp - prevMessage.timestamp
            if (deltaSecs > 0 && deltaSecs < 3600) durationMs = deltaSecs * 1000
          }
        }

        return (
          <div key={message.id}>
            <MessageItem
              message={message}
              messageIndex={index}
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
                index === lastPlanMessageIndex ? approveButtonRef : undefined
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
})
