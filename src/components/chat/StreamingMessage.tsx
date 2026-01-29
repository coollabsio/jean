import { memo } from 'react'
import { Markdown } from '@/components/ui/markdown'
import type {
  ToolCall,
  ContentBlock,
  Question,
  QuestionAnswer,
  ThinkingLevel,
  ExecutionMode,
} from '@/types/chat'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { AskUserQuestion } from './AskUserQuestion'
import { ToolCallInline, TaskCallInline, StackedGroup } from './ToolCallInline'
import { buildTimeline, findPlanFilePath } from './tool-call-utils'
import { ToolCallsDisplay } from './ToolCallsDisplay'
import { ExitPlanModeButton } from './ExitPlanModeButton'
import { PlanDisplay } from './PlanFileDisplay'
import { EditedFilesDisplay } from './EditedFilesDisplay'
import { ThinkingBlock } from './ThinkingBlock'

interface StreamingMessageProps {
  /** Session ID for the streaming message */
  sessionId: string
  /** Streaming content blocks (new format) */
  contentBlocks: ContentBlock[]
  /** Active tool calls during streaming */
  toolCalls: ToolCall[]
  /** Raw streaming content (fallback for old format) */
  streamingContent: string
  /** Execution mode that was active when message was sent */
  streamingExecutionMode: ExecutionMode
  /** Current thinking level setting */
  selectedThinkingLevel: ThinkingLevel
  /** Keyboard shortcut for approve button */
  approveShortcut: string
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
  /** Check if a question has been answered */
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  /** Get submitted answers for a question */
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  /** Check if questions are being skipped for this session */
  areQuestionsSkipped: (sessionId: string) => boolean
  /** Check if streaming plan has been approved */
  isStreamingPlanApproved: (sessionId: string) => boolean
  /** Callback when user approves streaming plan */
  onStreamingPlanApproval: () => void
  /** Callback when user approves streaming plan with yolo mode */
  onStreamingPlanApprovalYolo?: () => void
}

/**
 * Renders the currently streaming message
 * Memoized to isolate streaming updates from message list
 */
export const StreamingMessage = memo(function StreamingMessage({
  sessionId,
  contentBlocks,
  toolCalls,
  streamingContent,
  streamingExecutionMode,
  approveShortcut,
  onQuestionAnswer,
  onQuestionSkip,
  onFileClick,
  onEditedFileClick,
  isQuestionAnswered,
  getSubmittedAnswers,
  areQuestionsSkipped,
  isStreamingPlanApproved,
  onStreamingPlanApproval,
  onStreamingPlanApprovalYolo,
}: StreamingMessageProps) {
  // DEBUG: Log callback chain
  console.log(
    '[StreamingMessage] render, onStreamingPlanApproval:',
    typeof onStreamingPlanApproval
  )
  return (
    <div className="text-muted-foreground">
      {/* Render streaming content blocks inline if available */}
      {contentBlocks.length > 0 ? (
        (() => {
          const timeline = buildTimeline(contentBlocks, toolCalls)
          // Find last incomplete item index for spinner (only show spinner on last one)
          const lastIncompleteIndex = timeline.reduce((lastIdx, item, idx) => {
            if (item.type === 'task' && !item.taskTool.output) return idx
            if (item.type === 'standalone' && !item.tool.output) return idx
            if (item.type === 'stackedGroup' && item.items.some(i => i.type === 'tool' && !i.tool.output)) return idx
            return lastIdx
          }, -1)

          return (
        <>
          {/* Build timeline preserving order of text and tools */}
          <div className="space-y-4">
            {timeline.map((item, index) => {
              const isLastIncomplete = index === lastIncompleteIndex
              switch (item.type) {
                case 'thinking':
                  return (
                    <ThinkingBlock
                      key={item.key}
                      thinking={item.thinking}
                      isStreaming={true}
                    />
                  )
                case 'text':
                  return (
                    <Markdown key={item.key} streaming>
                      {item.text}
                    </Markdown>
                  )
                case 'task':
                  return (
                    <TaskCallInline
                      key={item.key}
                      taskToolCall={item.taskTool}
                      subToolCalls={item.subTools}
                      onFileClick={onFileClick}
                      isStreaming={true}
                      isLastIncomplete={isLastIncomplete}
                    />
                  )
                case 'standalone':
                  return (
                    <ToolCallInline
                      key={item.key}
                      toolCall={item.tool}
                      onFileClick={onFileClick}
                      isStreaming={true}
                      isLastIncomplete={isLastIncomplete}
                    />
                  )
                case 'stackedGroup':
                  return (
                    <StackedGroup
                      key={item.key}
                      items={item.items}
                      onFileClick={onFileClick}
                      isStreaming={true}
                      isLastIncomplete={isLastIncomplete}
                    />
                  )
                case 'askUserQuestion': {
                  // Render during streaming - Claude blocks waiting for user input
                  const isAnswered = isQuestionAnswered(sessionId, item.tool.id)
                  const input = item.tool.input as {
                    questions: Question[]
                  }
                  return (
                    <AskUserQuestion
                      key={item.key}
                      toolCallId={item.tool.id}
                      questions={input.questions}
                      introText={item.introText}
                      onSubmit={(toolCallId, answers) =>
                        onQuestionAnswer(toolCallId, answers, input.questions)
                      }
                      onSkip={onQuestionSkip}
                      readOnly={isAnswered}
                      submittedAnswers={
                        isAnswered
                          ? getSubmittedAnswers(sessionId, item.tool.id)
                          : undefined
                      }
                    />
                  )
                }
                case 'exitPlanMode': {
                  // Render plan content + approval button during streaming
                  // Extract plan from this specific tool's input (not global search)
                  const toolInput = item.tool.input as { plan?: string } | undefined
                  const inlinePlan = toolInput?.plan
                  const planFilePath = !inlinePlan
                    ? findPlanFilePath(toolCalls)
                    : null
                  const isApproved = isStreamingPlanApproved(sessionId)

                  return (
                    <div key={item.key}>
                      {inlinePlan ? (
                        <PlanDisplay
                          content={inlinePlan}
                          defaultCollapsed={isApproved}
                        />
                      ) : planFilePath ? (
                        <PlanDisplay
                          filePath={planFilePath}
                          defaultCollapsed={isApproved}
                        />
                      ) : null}
                      <ExitPlanModeButton
                        toolCalls={toolCalls}
                        isApproved={isApproved}
                        onPlanApproval={onStreamingPlanApproval}
                        onPlanApprovalYolo={onStreamingPlanApprovalYolo}
                        shortcut={approveShortcut}
                      />
                    </div>
                  )
                }
                default:
                  return null
              }
            })}
          </div>
        </>
          )
        })()
      ) : (
        <>
          {/* Fallback: Collapsible tool calls during streaming (old behavior) */}
          <ToolCallsDisplay
            toolCalls={toolCalls}
            sessionId={sessionId}
            defaultExpanded={false}
            isStreaming={true}
            onQuestionAnswer={onQuestionAnswer}
            onQuestionSkip={onQuestionSkip}
            isQuestionAnswered={isQuestionAnswered}
            getSubmittedAnswers={getSubmittedAnswers}
            areQuestionsSkipped={areQuestionsSkipped}
          />
          {/* Streaming content */}
          {streamingContent && (
            <Markdown streaming>{streamingContent}</Markdown>
          )}
        </>
      )}

      {/* Show edited files during streaming */}
      <EditedFilesDisplay
        toolCalls={toolCalls}
        onFileClick={onEditedFileClick}
      />

      {/* Show status indicator - waiting when question pending, planning/vibing otherwise */}
      <div className="text-sm text-muted-foreground/60 mt-4">
        <span className="animate-shimmer">
          {toolCalls.some(
            tc =>
              (isAskUserQuestion(tc) || isExitPlanMode(tc)) &&
              !isQuestionAnswered(sessionId, tc.id)
          )
            ? 'Waiting for your input'
            : streamingExecutionMode === 'plan'
              ? 'Planning...'
              : streamingExecutionMode === 'yolo'
                ? 'Yoloing...'
                : 'Vibing...'}
        </span>
      </div>
    </div>
  )
})
