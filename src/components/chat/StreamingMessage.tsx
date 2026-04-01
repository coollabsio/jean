import { memo } from 'react'
import { Markdown } from '@/components/ui/markdown'
import type {
  ToolCall,
  ContentBlock,
  Question,
  QuestionAnswer,
} from '@/types/chat'
import { AskUserQuestion } from './AskUserQuestion'
import { ToolCallInline, TaskCallInline, StackedGroup } from './ToolCallInline'
import {
  buildTimeline,
  findPlanFilePath,
  getPlanTextBlockIndicesToHide,
  isDuplicatePlanTextBlock,
  resolvePlanContent,
  splitTextAroundPlan,
} from './tool-call-utils'
import { ToolCallsDisplay } from './ToolCallsDisplay'
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
  onQuestionAnswer,
  onQuestionSkip,
  onFileClick,
  onEditedFileClick,
  isQuestionAnswered,
  getSubmittedAnswers,
  areQuestionsSkipped,
}: StreamingMessageProps) {
  const resolvedPlan = resolvePlanContent({
    toolCalls,
    messageContent: streamingContent,
    contentBlocks,
  })
  const hiddenPlanTextBlockIndices = getPlanTextBlockIndicesToHide(
    contentBlocks,
    resolvedPlan.content
  )
  const fallbackTextSplit = splitTextAroundPlan(streamingContent)
  const fallbackPrePlanText = isDuplicatePlanTextBlock(
    streamingContent,
    resolvedPlan.content
  )
    ? fallbackTextSplit.beforePlan
    : null

  return (
    <div className="text-foreground/90">
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
            else if (
              item.type === 'standalone' &&
              item.tool.output === undefined
            )
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
                {(() => {
                  const hasRenderedPlanItem = timeline.some(
                    item => item.type === 'exitPlanMode'
                  )

                  return (
                    <>
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
                                case 'text': {
                                  const textBlockIndex =
                                    contentBlocks.findIndex(
                                      block =>
                                        block.type === 'text' &&
                                        block.text === item.text
                                    )
                                  if (
                                    textBlockIndex >= 0 &&
                                    hiddenPlanTextBlockIndices.has(
                                      textBlockIndex
                                    )
                                  ) {
                                    return null
                                  }
                                  if (
                                    isDuplicatePlanTextBlock(
                                      item.text,
                                      resolvedPlan.content
                                    )
                                  ) {
                                    return null
                                  }
                                  // Split at last newline: completed lines → markdown, trailing partial → plain div
                                  // This prevents reflow when remend reinterprets incomplete markdown
                                  const lastNewline =
                                    item.text.lastIndexOf('\n')
                                  const rawComplete =
                                    lastNewline !== -1
                                      ? item.text.slice(0, lastNewline + 1)
                                      : ''
                                  // Trim trailing whitespace so markdown doesn't render a trailing <br> from "  \n"
                                  const completePart = rawComplete.trimEnd()
                                  const trailingPart =
                                    lastNewline !== -1
                                      ? item.text.slice(lastNewline + 1)
                                      : item.text
                                  return (
                                    <div>
                                      {completePart && (
                                        <Markdown streaming>
                                          {completePart}
                                        </Markdown>
                                      )}
                                      {trailingPart && (
                                        <p className="my-0 leading-relaxed">
                                          {trailingPart}
                                        </p>
                                      )}
                                    </div>
                                  )
                                }
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
                                  const rawInput = item.tool.input as {
                                    questions: (Question & {
                                      multiple?: boolean
                                    })[]
                                  }
                                  // Normalize OpenCode's "multiple" → "multiSelect"
                                  const normalizedQuestions =
                                    rawInput.questions.map(q => ({
                                      ...q,
                                      multiSelect:
                                        q.multiSelect ?? q.multiple === true,
                                    }))
                                  return (
                                    <AskUserQuestion
                                      toolCallId={item.tool.id}
                                      questions={normalizedQuestions}
                                      introText={item.introText}
                                      hasFollowUpMessage={Boolean(
                                        item.tool.output
                                      )}
                                      onSubmit={(toolCallId, answers) =>
                                        onQuestionAnswer(
                                          toolCallId,
                                          answers,
                                          normalizedQuestions
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
                                      toolOutput={item.tool.output}
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
                                  const inlinePlan = resolvePlanContent({
                                    toolCalls: [item.tool],
                                    messageContent: streamingContent,
                                    contentBlocks,
                                  }).content
                                  const planFilePath = !inlinePlan
                                    ? findPlanFilePath(toolCalls)
                                    : null
                                  return (
                                    <div data-plan-display>
                                      {inlinePlan ? (
                                        <PlanDisplay
                                          content={inlinePlan}
                                          defaultCollapsed={false}
                                        />
                                      ) : planFilePath ? (
                                        <PlanDisplay
                                          filePath={planFilePath}
                                          defaultCollapsed={false}
                                        />
                                      ) : null}
                                    </div>
                                  )
                                }
                                case 'unknown':
                                  return (
                                    <div className="text-xs text-muted-foreground border rounded px-2 py-1">
                                      Unsupported content type: &quot;
                                      {item.rawType}
                                      &quot; — if you see this, please report it
                                      as a bug
                                    </div>
                                  )
                                default:
                                  return null
                              }
                            })()}
                          </ErrorBoundary>
                        )
                      })}
                      {resolvedPlan.content && !hasRenderedPlanItem && (
                        <div data-plan-display>
                          <PlanDisplay
                            content={resolvedPlan.content}
                            defaultCollapsed={false}
                          />
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            </>
          )
        })()
      ) : (
        <>
          {fallbackPrePlanText && (
            <Markdown streaming>{fallbackPrePlanText}</Markdown>
          )}
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
          {resolvedPlan.content && (
            <div data-plan-display>
              <PlanDisplay
                content={resolvedPlan.content}
                defaultCollapsed={false}
              />
            </div>
          )}
          {/* Streaming content */}
          {streamingContent &&
            !isDuplicatePlanTextBlock(
              streamingContent,
              resolvedPlan.content
            ) && <Markdown streaming>{streamingContent}</Markdown>}
        </>
      )}

      {/* Show edited files during streaming */}
      <EditedFilesDisplay
        toolCalls={toolCalls}
        onFileClick={onEditedFileClick}
      />
    </div>
  )
})
