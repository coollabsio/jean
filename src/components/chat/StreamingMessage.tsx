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
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { logger } from '@/lib/logger'

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
  /** Keyboard shortcut for approve yolo button */
  approveShortcutYolo?: string
  /** Keyboard shortcut for clear context button */
  approveShortcutClearContext?: string
  /** Keyboard shortcut for clear context and build button */
  approveShortcutClearContextBuild?: string
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
  /** Callback for clear context approval during streaming */
  onStreamingClearContextApproval?: () => void
  /** Callback for clear context and build approval during streaming */
  onStreamingClearContextApprovalBuild?: () => void
  /** Callback for worktree build approval during streaming */
  onStreamingWorktreeBuildApproval?: () => void
  /** Callback for worktree yolo approval during streaming */
  onStreamingWorktreeYoloApproval?: () => void
  /** Hide approve buttons (e.g. for Codex which has no native approval flow) */
  hideApproveButtons?: boolean
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
  approveShortcutYolo,
  approveShortcutClearContext,
  approveShortcutClearContextBuild,
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
  onStreamingClearContextApproval,
  onStreamingClearContextApprovalBuild,
  onStreamingWorktreeBuildApproval,
  onStreamingWorktreeYoloApproval,
  hideApproveButtons,
}: StreamingMessageProps) {
  return (
    <div className="text-muted-foreground">
      {/* Render streaming content blocks inline if available */}
      {contentBlocks.length > 0 ? (
        (() => {
          let timeline
          try {
            timeline = buildTimeline(contentBlocks, toolCalls)
          } catch (e) {
            logger.error('Failed to build streaming timeline', {
              sessionId,
              error: e,
            })
            return (
              <div className="text-sm text-muted-foreground italic">
                [Streaming content could not be rendered]
              </div>
            )
          }
          // Find all incomplete item indices for spinner (show on all in-progress tools)
          // Use === undefined check since empty string is a valid "completed" output (e.g. Read tools)
          const incompleteIndices = new Set<number>()
          timeline.forEach((item, idx) => {
            if (item.type === 'task' && item.taskTool.output === undefined)
              incompleteIndices.add(idx)
            else if (item.type === 'standalone' && item.tool.output === undefined)
              incompleteIndices.add(idx)
            else if (
              item.type === 'stackedGroup' &&
              item.items.some(
                i => i.type === 'tool' && i.tool.output === undefined
              )
            )
              incompleteIndices.add(idx)
          })

          return (
            <>
              {/* Build timeline preserving order of text and tools */}
              <div className="space-y-4">
                {timeline.map((item, index) => {
                  const isIncomplete = incompleteIndices.has(index)
                  return (
                    <ErrorBoundary
                      key={item.key}
                      fallback={
                        <div className="text-xs text-muted-foreground italic border rounded px-2 py-1">
                          [Failed to render content]
                        </div>
                      }
                    >
                      {(() => {
                        switch (item.type) {
                          case 'thinking':
                            return (
                              <ThinkingBlock
                                thinking={item.thinking}
                                isStreaming={true}
                              />
                            )
                          case 'text':
                            return <Markdown streaming>{item.text}</Markdown>
                          case 'task':
                            return (
                              <TaskCallInline
                                taskToolCall={item.taskTool}
                                subToolCalls={item.subTools}
                                allToolCalls={toolCalls}
                                onFileClick={onFileClick}
                                isStreaming={true}
                                isIncomplete={isIncomplete}
                              />
                            )
                          case 'standalone':
                            return (
                              <ToolCallInline
                                toolCall={item.tool}
                                onFileClick={onFileClick}
                                isStreaming={true}
                                isIncomplete={isIncomplete}
                              />
                            )
                          case 'stackedGroup':
                            return (
                              <StackedGroup
                                items={item.items}
                                onFileClick={onFileClick}
                                isStreaming={true}
                                isIncomplete={isIncomplete}
                              />
                            )
                          case 'askUserQuestion': {
                            const isAnswered = isQuestionAnswered(
                              sessionId,
                              item.tool.id
                            )
                            const input = item.tool.input as {
                              questions: Question[]
                            }
                            return (
                              <AskUserQuestion
                                toolCallId={item.tool.id}
                                questions={input.questions}
                                introText={item.introText}
                                onSubmit={(toolCallId, answers) =>
                                  onQuestionAnswer(
                                    toolCallId,
                                    answers,
                                    input.questions
                                  )
                                }
                                onSkip={onQuestionSkip}
                                readOnly={isAnswered}
                                submittedAnswers={
                                  isAnswered
                                    ? getSubmittedAnswers(
                                        sessionId,
                                        item.tool.id
                                      )
                                    : undefined
                                }
                              />
                            )
                          }
                          case 'enterPlanMode':
                            return (
                              <ToolCallInline
                                toolCall={item.tool}
                                onFileClick={onFileClick}
                                isStreaming={true}
                                isIncomplete={false}
                              />
                            )
                          case 'exitPlanMode': {
                            const toolInput = item.tool.input as
                              | { plan?: string }
                              | undefined
                            const inlinePlan = toolInput?.plan
                            const planFilePath = !inlinePlan
                              ? findPlanFilePath(toolCalls)
                              : null
                            const isApproved =
                              isStreamingPlanApproved(sessionId)

                            return (
                              <div data-plan-display>
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
                                  onPlanApprovalYolo={
                                    onStreamingPlanApprovalYolo
                                  }
                                  onClearContextApproval={
                                    onStreamingClearContextApproval
                                  }
                                  onClearContextBuildApproval={
                                    onStreamingClearContextApprovalBuild
                                  }
                                  onWorktreeBuildApproval={
                                    onStreamingWorktreeBuildApproval
                                  }
                                  onWorktreeYoloApproval={
                                    onStreamingWorktreeYoloApproval
                                  }
                                  shortcut={approveShortcut}
                                  shortcutYolo={approveShortcutYolo}
                                  shortcutClearContext={approveShortcutClearContext}
                                  shortcutClearContextBuild={approveShortcutClearContextBuild}
                                  hideApproveButtons={hideApproveButtons}
                                />
                              </div>
                            )
                          }
                          case 'unknown':
                            return (
                              <div className="text-xs text-muted-foreground border rounded px-2 py-1">
                                Unsupported content type: &quot;{item.rawType}
                                &quot; — if you see this, please report it as a
                                bug
                              </div>
                            )
                          default:
                            return null
                        }
                      })()}
                    </ErrorBoundary>
                  )
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
        <span className="animate-dots">
          {toolCalls.some(
            tc =>
              (isAskUserQuestion(tc) || isExitPlanMode(tc)) &&
              !isQuestionAnswered(sessionId, tc.id)
          )
            ? 'Waiting for your input'
            : streamingExecutionMode === 'plan'
              ? 'Planning'
              : streamingExecutionMode === 'yolo'
                ? 'Yoloing'
                : 'Vibing'}
        </span>
      </div>
    </div>
  )
})
