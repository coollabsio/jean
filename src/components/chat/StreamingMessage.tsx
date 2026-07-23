import { memo, useCallback, useMemo } from 'react'
import { Activity, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Markdown } from '@/components/ui/markdown'
import type {
  ToolCall,
  ContentBlock,
  Question,
  QuestionAnswer,
} from '@/types/chat'
import {
  getAskUserQuestions,
  normalizeQuestionMultipleField,
} from '@/types/chat'
import { copyToClipboard } from '@/lib/clipboard'
import { AskUserQuestion } from './AskUserQuestion'
import {
  ToolCallInline,
  TaskCallInline,
  StackedGroup,
  TOOL_CALL_ROW_CLASS,
} from './ToolCallInline'
import {
  buildTimeline,
  findPlanFilePath,
  getIntroTextBeforeDuplicatePlan,
  getPlanTextBlockIndicesToHide,
  isDuplicatePlanTextBlock,
  resolvePlanContent,
  type TimelineItem,
} from './tool-call-utils'
import { ToolCallsDisplay } from './ToolCallsDisplay'
import { PlanDisplay } from './PlanFileDisplay'
import { EditedFilesDisplay } from './EditedFilesDisplay'
import { ThinkingBlock } from './ThinkingBlock'
import { SteeredPromptGroup } from './SteeredPromptGroup'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { logger } from '@/lib/logger'
import { MessageThreadContextMenu } from './message-thread-context-menu'

function WorkingVisualRow() {
  return (
    <div className="rounded-md border border-border/50 bg-muted/30 min-w-0">
      <div className={TOOL_CALL_ROW_CLASS}>
        <Activity className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="font-medium shrink-0 flex-none whitespace-nowrap">
          Working…
        </span>
        <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
      </div>
    </div>
  )
}

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
  /** Worktree path for resolving file mentions */
  worktreePath?: string
  /** Check if a question has been answered */
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  /** Get submitted answers for a question */
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  /** Check if questions are being skipped for this session */
  areQuestionsSkipped: (sessionId: string) => boolean
  /** Callback to copy a steered user prompt */
  onCopySteeredText?: (text: string) => void
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
  worktreePath,
  isQuestionAnswered,
  getSubmittedAnswers,
  areQuestionsSkipped,
  onCopySteeredText,
}: StreamingMessageProps) {
  const resolvedPlan = useMemo(
    () =>
      resolvePlanContent({
        toolCalls,
        messageContent: streamingContent,
        contentBlocks,
      }),
    [toolCalls, streamingContent, contentBlocks]
  )
  const hiddenPlanTextBlockIndices = useMemo(
    () => getPlanTextBlockIndicesToHide(contentBlocks, resolvedPlan.content),
    [contentBlocks, resolvedPlan.content]
  )
  const fallbackPrePlanText = useMemo(
    () =>
      getIntroTextBeforeDuplicatePlan(streamingContent, resolvedPlan.content),
    [streamingContent, resolvedPlan.content]
  )

  // Timeline construction is O(blocks + tools) and runs on every streaming
  // frame otherwise — memoize on the immutable store slices it derives from.
  const timelineData = useMemo(() => {
    if (contentBlocks.length === 0) return null
    let timeline: TimelineItem[]
    try {
      timeline = buildTimeline(contentBlocks, toolCalls)
    } catch (e) {
      logger.error('Failed to build streaming timeline', {
        sessionId,
        error: e,
      })
      return { error: true as const }
    }
    // First contentBlocks index per text block content — replaces a per-item
    // O(n) findIndex during render.
    const textBlockIndexByText = new Map<string, number>()
    contentBlocks.forEach((block, index) => {
      if (block.type === 'text' && !textBlockIndexByText.has(block.text)) {
        textBlockIndexByText.set(block.text, index)
      }
    })
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
        item.items.some(i => i.type === 'tool' && i.tool.output === undefined)
      )
        incompleteIndices.add(idx)
    })
    return {
      error: false as const,
      timeline,
      textBlockIndexByText,
      incompleteIndices,
    }
  }, [contentBlocks, toolCalls, sessionId])

  const streamingResponseText = useMemo(() => {
    const fromBlocks = contentBlocks
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim()
    return fromBlocks || streamingContent.trim()
  }, [contentBlocks, streamingContent])

  const handleCopyStreamingResponse = useCallback(() => {
    if (!streamingResponseText) return
    void copyToClipboard(streamingResponseText)
      .then(() => toast.success('Response copied to clipboard'))
      .catch(() => toast.error('Failed to copy response'))
  }, [streamingResponseText])

  return (
    <MessageThreadContextMenu
      messageText={streamingResponseText}
      copyMessageLabel="Copy response"
      onCopyMessage={
        streamingResponseText ? handleCopyStreamingResponse : undefined
      }
    >
      <div className="text-foreground/90">
        {/* Render streaming content blocks inline if available */}
        {timelineData ? (
          (() => {
            if (timelineData.error) {
              return (
                <div className="text-sm text-muted-foreground italic">
                  [Streaming content could not be rendered]
                </div>
              )
            }
            const { timeline, textBlockIndexByText, incompleteIndices } =
              timelineData
            const hasRenderedTextItem = timeline.some(
              item => item.type === 'text'
            )
            const fallbackStreamingIntro = !hasRenderedTextItem
              ? (fallbackPrePlanText ??
                (!isDuplicatePlanTextBlock(
                  streamingContent,
                  resolvedPlan.content
                )
                  ? streamingContent
                  : null))
              : null

            return (
              <>
                {fallbackStreamingIntro && (
                  <Markdown streaming>{fallbackStreamingIntro}</Markdown>
                )}
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
                                      textBlockIndexByText.get(item.text) ?? -1
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
                                    return (
                                      <Markdown streaming>{item.text}</Markdown>
                                    )
                                  }
                                  case 'userInput':
                                    return (
                                      <SteeredPromptGroup
                                        texts={item.texts}
                                        worktreePath={worktreePath}
                                        onCopyText={onCopySteeredText}
                                      />
                                    )
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
                                    // Normalize OpenCode's "multiple" → "multiSelect"
                                    const normalizedQuestions =
                                      normalizeQuestionMultipleField(
                                        (getAskUserQuestions(item.tool.input) ??
                                          []) as (Question & {
                                          multiple?: boolean
                                        })[]
                                      )
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
                                        &quot; — if you see this, please report
                                        it as a bug
                                      </div>
                                    )
                                  default:
                                    return null
                                }
                              })()}
                            </ErrorBoundary>
                          )
                        })}
                        {timeline.at(-1)?.type === 'userInput' && (
                          <WorkingVisualRow />
                        )}
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
        <EditedFilesDisplay toolCalls={toolCalls} />
      </div>
    </MessageThreadContextMenu>
  )
})
