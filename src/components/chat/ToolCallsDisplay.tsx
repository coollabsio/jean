import { memo, useState, useCallback } from 'react'
import type { ToolCall, Question, QuestionAnswer } from '@/types/chat'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { AskUserQuestion } from './AskUserQuestion'

/**
 * Merge multiple AskUserQuestion tool calls into a single question set.
 * Claude sometimes emits multiple AskUserQuestion calls during streaming.
 * We deduplicate by question header, preferring the first occurrence.
 */
function mergeAskUserQuestions(tools: ToolCall[]): Question[] {
  const seenHeaders = new Set<string>()
  const merged: Question[] = []

  for (const tool of tools) {
    const questions =
      (tool.input as { questions?: Question[] })?.questions ?? []
    for (const q of questions) {
      // Use header if present, otherwise use question text as fallback key
      const key = q.header ?? q.question
      if (!seenHeaders.has(key)) {
        seenHeaders.add(key)
        merged.push(q)
      }
    }
  }
  return merged
}

interface ToolCallsDisplayProps {
  toolCalls: ToolCall[]
  sessionId: string
  defaultExpanded?: boolean
  isStreaming?: boolean
  /** True if a user message follows this assistant message (means questions were answered) */
  hasFollowUpMessage?: boolean
  onQuestionAnswer?: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  /** Callback when user skips a question */
  onQuestionSkip?: (toolCallId: string) => void
  /** Check if a question has been answered (passed from parent to ensure reactivity) */
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  /** Get submitted answers for a question (passed from parent to ensure reactivity) */
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  /** Check if questions are being skipped for this session */
  areQuestionsSkipped?: (sessionId: string) => boolean
}

/**
 * Display for tool calls - shows Edit tools prominently, collapses others
 * Note: ExitPlanMode is handled by ExitPlanModeButton component (rendered after content)
 * Memoized to prevent re-renders when parent state changes
 */
export const ToolCallsDisplay = memo(function ToolCallsDisplay({
  toolCalls,
  sessionId,
  defaultExpanded = false,
  isStreaming = false,
  hasFollowUpMessage = false,
  onQuestionAnswer,
  isQuestionAnswered,
  getSubmittedAnswers,
  onQuestionSkip,
  areQuestionsSkipped,
}: ToolCallsDisplayProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  // Memoized toggle handler
  const handleToggle = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  // Separate special tools from regular tools
  // Note: ExitPlanMode is handled separately outside this component (after content)
  // Note: Edit tools are handled by EditedFilesDisplay at the bottom of the message
  const questionTools = toolCalls.filter(isAskUserQuestion)
  const otherTools = toolCalls.filter(
    t => !isAskUserQuestion(t) && !isExitPlanMode(t)
  )

  // Merge multiple AskUserQuestion calls into one (Claude sometimes emits duplicates)
  const mergedQuestions =
    questionTools.length > 0 ? mergeAskUserQuestions(questionTools) : null
  // Use first tool's id for the merged questions (for answer tracking)
  const mergedToolId = questionTools[0]?.id

  if (toolCalls.length === 0) return null

  return (
    <div className="mb-2 space-y-1">
      {/* Tool calls (collapsible) - Edit tools are shown separately at the bottom */}
      {otherTools.length > 0 && (
        <>
          <button
            type="button"
            onClick={handleToggle}
            className="text-xs text-muted-foreground/70 hover:text-muted-foreground"
          >
            {expanded ? '▼' : '▶'} {otherTools.length} tool
            {otherTools.length === 1 ? '' : 's'} used
          </button>
          {expanded && (
            <div className="ml-4 mt-1 max-w-xl space-y-1 text-xs text-muted-foreground/60">
              {otherTools.map(tool => (
                <div key={tool.id}>
                  <span className="font-medium">{tool.name}</span>
                  {tool.input != null && (
                    <div className="overflow-x-auto">
                      <pre className="mt-0.5 max-w-full text-[0.625rem] leading-tight whitespace-pre-wrap break-words">
                        {typeof tool.input === 'string'
                          ? tool.input
                          : JSON.stringify(tool.input, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* AskUserQuestion tools - merged into one, only render when not streaming */}
      {!isStreaming && mergedQuestions && mergedToolId && (
        <AskUserQuestion
          key={mergedToolId}
          toolCallId={mergedToolId}
          questions={mergedQuestions}
          hasFollowUpMessage={hasFollowUpMessage}
          isSkipped={areQuestionsSkipped?.(sessionId) ?? false}
          onSubmit={(toolCallId, answers) =>
            onQuestionAnswer?.(toolCallId, answers, mergedQuestions)
          }
          onSkip={onQuestionSkip}
          readOnly={
            hasFollowUpMessage ||
            isQuestionAnswered(sessionId, mergedToolId) ||
            areQuestionsSkipped?.(sessionId)
          }
          submittedAnswers={
            hasFollowUpMessage ||
            isQuestionAnswered(sessionId, mergedToolId) ||
            areQuestionsSkipped?.(sessionId)
              ? getSubmittedAnswers(sessionId, mergedToolId)
              : undefined
          }
        />
      )}
    </div>
  )
})
