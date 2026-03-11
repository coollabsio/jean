import { memo, useCallback } from 'react'
import { Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { normalizePath } from '@/lib/path-utils'
import { Markdown } from '@/components/ui/markdown'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'
import { AskUserQuestion } from './AskUserQuestion'
import { ToolCallInline, TaskCallInline, StackedGroup } from './ToolCallInline'
import { buildTimeline, findPlanFilePath } from './tool-call-utils'
import { PlanDisplay } from './PlanFileDisplay'
import { ImageLightbox } from './ImageLightbox'
import { TextFileLightbox } from './TextFileLightbox'
import { FileMentionBadge } from './FileMentionBadge'
import { SkillBadge } from './SkillBadge'
import { ToolCallsDisplay } from './ToolCallsDisplay'
import { ExitPlanModeButton } from './ExitPlanModeButton'
import { EditedFilesDisplay } from './EditedFilesDisplay'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { ThinkingBlock } from './ThinkingBlock'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { logger } from '@/lib/logger'
import {
  parseReviewFindings,
  hasReviewFindings,
  stripFindingBlocks,
} from './review-finding-utils'
import { ReviewFindingsList } from './ReviewFindingBlock'
import {
  extractImagePaths,
  extractTextFilePaths,
  extractFileMentionPaths,
  extractDirectoryMentionPaths,
  extractSkillPaths,
  stripAllMarkers,
} from './message-content-utils'

interface MessageItemProps {
  /** The message to render */
  message: ChatMessage
  /** Index of this message in the message list */
  messageIndex: number
  /** Total number of messages (to determine if this is the last message) */
  totalMessages: number
  /** Index of the last plan message (for approve button logic) */
  lastPlanMessageIndex: number
  /** Pre-computed: does a user message follow this one? */
  hasFollowUpMessage: boolean
  /** Session ID for this message */
  sessionId: string
  /** Worktree path for resolving file mentions */
  worktreePath: string
  /** Keyboard shortcut to display on approve button */
  approveShortcut: string
  /** Keyboard shortcut to display on approve yolo button */
  approveShortcutYolo?: string
  /** Keyboard shortcut to display on clear context button */
  approveShortcutClearContext?: string
  /** Keyboard shortcut to display on clear context build button */
  approveShortcutClearContextBuild?: string
  /** Ref to attach to approve button for visibility tracking */
  approveButtonRef?: React.RefObject<HTMLButtonElement | null>
  /** Whether Claude is currently streaming (affects last message rendering) */
  isSending: boolean
  /** Callback when user approves a plan */
  onPlanApproval: (messageId: string) => void
  /** Callback when user approves a plan with yolo mode */
  onPlanApprovalYolo?: (messageId: string) => void
  /** Callback for clear context approval (new session with plan in yolo mode) */
  onClearContextApproval?: (messageId: string) => void
  /** Callback for clear context approval (new session with plan in build mode) */
  onClearContextApprovalBuild?: (messageId: string) => void
  /** Callback for worktree approval (new worktree with plan in build mode) */
  onWorktreeBuildApproval?: (messageId: string) => void
  /** Callback for worktree approval (new worktree with plan in yolo mode) */
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
}

/**
 * Renders a single chat message (user or assistant)
 * Memoized to prevent re-renders when sibling messages change
 */
export const MessageItem = memo(function MessageItem({
  message,
  messageIndex,
  totalMessages,
  lastPlanMessageIndex,
  hasFollowUpMessage,
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
}: MessageItemProps) {
  // Only show Approve button for the last message with ExitPlanMode
  const isLatestPlanRequest = messageIndex === lastPlanMessageIndex

  // Extract image, text file, file mention, and skill paths and clean content for user messages
  const imagePaths =
    message.role === 'user' ? extractImagePaths(message.content) : []
  const textFilePaths =
    message.role === 'user' ? extractTextFilePaths(message.content) : []
  const fileMentionPaths =
    message.role === 'user' ? extractFileMentionPaths(message.content) : []
  const directoryMentionPaths =
    message.role === 'user' ? extractDirectoryMentionPaths(message.content) : []
  const skillPaths =
    message.role === 'user' ? extractSkillPaths(message.content) : []
  const displayContent =
    message.role === 'user' ? stripAllMarkers(message.content) : message.content

  // Show content if it's not empty
  const showContent = displayContent.trim()

  // Skip tool calls for the last assistant message if we're streaming
  // (the streaming section handles rendering those)
  const isLastMessage = messageIndex === totalMessages - 1
  const skipToolCalls =
    isSending && isLastMessage && message.role === 'assistant'

  // Stable callback for plan approval
  const handlePlanApproval = useCallback(() => {
    onPlanApproval(message.id)
  }, [onPlanApproval, message.id])

  // Stable callback for plan approval with yolo mode
  const handlePlanApprovalYolo = useCallback(() => {
    onPlanApprovalYolo?.(message.id)
  }, [onPlanApprovalYolo, message.id])

  // Stable callback for clear context approval
  const handleClearContextApproval = useCallback(() => {
    onClearContextApproval?.(message.id)
  }, [onClearContextApproval, message.id])

  // Stable callback for clear context build approval
  const handleClearContextApprovalBuild = useCallback(() => {
    onClearContextApprovalBuild?.(message.id)
  }, [onClearContextApprovalBuild, message.id])

  // Stable callback for worktree build approval
  const handleWorktreeBuildApproval = useCallback(() => {
    onWorktreeBuildApproval?.(message.id)
  }, [onWorktreeBuildApproval, message.id])

  // Stable callback for worktree yolo approval
  const handleWorktreeYoloApproval = useCallback(() => {
    onWorktreeYoloApproval?.(message.id)
  }, [onWorktreeYoloApproval, message.id])

  // Stable callback for checking if finding is fixed
  const handleIsFindingFixed = useCallback(
    (findingKey: string) => isFindingFixed(sessionId, findingKey),
    [isFindingFixed, sessionId]
  )

  // Stable callback for copying message to input
  const handleCopyToInput = useCallback(() => {
    onCopyToInput?.(message)
  }, [onCopyToInput, message])

  // Content for the message box (shared between user and assistant)
  const messageBoxContent = (
    <>
      {/* Show attached images for user messages */}
      {imagePaths.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {imagePaths.map((path, idx) => (
            <ImageLightbox
              key={`${message.id}-img-${idx}`}
              src={path}
              alt={`Attached image ${idx + 1}`}
              thumbnailClassName="h-20 max-w-40 object-contain rounded border border-border/50 cursor-pointer hover:border-primary/50 transition-colors"
            />
          ))}
        </div>
      )}

      {/* Show attached text files for user messages */}
      {textFilePaths.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {textFilePaths.map((path, idx) => (
            <TextFileLightbox key={`${message.id}-txt-${idx}`} path={path} />
          ))}
        </div>
      )}

      {/* Show attached file and directory mentions (@ mentions) for user messages */}
      {(fileMentionPaths.length > 0 || directoryMentionPaths.length > 0) && (
        <div className="flex flex-wrap gap-2 mb-2">
          {directoryMentionPaths.map((path, idx) => (
            <FileMentionBadge
              key={`${message.id}-dir-${idx}`}
              path={path}
              worktreePath={worktreePath}
              isDirectory
            />
          ))}
          {fileMentionPaths.map((path, idx) => (
            <FileMentionBadge
              key={`${message.id}-file-${idx}`}
              path={path}
              worktreePath={worktreePath}
            />
          ))}
        </div>
      )}

      {/* Show attached skills (/ mentions) for user messages */}
      {skillPaths.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {skillPaths.map((path, idx) => {
            // Extract skill name from path (e.g., /Users/.../skills/react/SKILL.md -> react)
            const parts = normalizePath(path).split('/')
            const skillsIdx = parts.findIndex(p => p === 'skills')
            const name =
              skillsIdx >= 0 && parts[skillsIdx + 1]
                ? parts[skillsIdx + 1]
                : path
            return (
              <SkillBadge
                key={`${message.id}-skill-${idx}`}
                skill={{
                  id: `${message.id}-skill-${idx}`,
                  name: name ?? path,
                  path,
                }}
                compact
              />
            )
          })}
        </div>
      )}

      {/* Render content blocks inline if available (new format) */}
      {message.role === 'assistant' &&
      message.content_blocks &&
      message.content_blocks.length > 0 &&
      !skipToolCalls ? (
        <>
          {/* Build timeline preserving order of text and tools */}
          <div className="space-y-4">
            {(() => {
              let timeline
              try {
                timeline = buildTimeline(
                  message.content_blocks,
                  message.tool_calls ?? []
                )
              } catch (e) {
                logger.error('Failed to build timeline for message', {
                  messageId: message.id,
                  error: e,
                })
                return (
                  <div className="text-sm text-muted-foreground italic">
                    <span>[Message could not be rendered]</span>
                    {message.content && <Markdown streaming={message.cancelled}>{message.content}</Markdown>}
                  </div>
                )
              }
              return timeline.map(item => (
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
                            isStreaming={false}
                          />
                        )
                      case 'text': {
                        if (hasReviewFindings(item.text)) {
                          const findings = parseReviewFindings(item.text)
                          const strippedText = stripFindingBlocks(item.text)
                          return (
                            <div>
                              <Markdown streaming={message.cancelled}>{strippedText}</Markdown>
                              {findings.length > 0 && (
                                <ReviewFindingsList
                                  findings={findings}
                                  sessionId={sessionId}
                                  onFix={onFixFinding}
                                  onFixAll={onFixAllFindings}
                                  isFixedFn={handleIsFindingFixed}
                                  disabled={isSending}
                                />
                              )}
                            </div>
                          )
                        }
                        return <Markdown streaming={message.cancelled}>{item.text}</Markdown>
                      }
                      case 'task':
                        return (
                          <TaskCallInline
                            taskToolCall={item.taskTool}
                            subToolCalls={item.subTools}
                            allToolCalls={message.tool_calls ?? []}
                            onFileClick={onFileClick}
                            isStreaming={false}
                          />
                        )
                      case 'standalone':
                        return (
                          <ToolCallInline
                            toolCall={item.tool}
                            onFileClick={onFileClick}
                            isStreaming={false}
                          />
                        )
                      case 'stackedGroup':
                        return (
                          <StackedGroup
                            items={item.items}
                            onFileClick={onFileClick}
                            isStreaming={false}
                          />
                        )
                      case 'askUserQuestion': {
                        const isAnswered =
                          hasFollowUpMessage ||
                          isQuestionAnswered(message.session_id, item.tool.id)
                        const input = item.tool.input as {
                          questions: Question[]
                        }
                        return (
                          <AskUserQuestion
                            toolCallId={item.tool.id}
                            questions={input.questions}
                            introText={item.introText}
                            hasFollowUpMessage={hasFollowUpMessage}
                            isSkipped={areQuestionsSkipped(
                              message.session_id
                            )}
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
                                    message.session_id,
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
                            isStreaming={false}
                          />
                        )
                      case 'exitPlanMode': {
                        const toolInput = item.tool.input as
                          | { plan?: string }
                          | undefined
                        const inlinePlan = toolInput?.plan
                        if (inlinePlan) {
                          return (
                            <PlanDisplay
                              content={inlinePlan}
                              defaultCollapsed={
                                message.plan_approved || hasFollowUpMessage
                              }
                            />
                          )
                        }
                        const planFilePath = findPlanFilePath(
                          message.tool_calls ?? []
                        )
                        if (!planFilePath) return null
                        return (
                          <PlanDisplay
                            filePath={planFilePath}
                            defaultCollapsed={
                              message.plan_approved || hasFollowUpMessage
                            }
                          />
                        )
                      }
                      case 'unknown':
                        return (
                          <div className="text-xs text-muted-foreground border rounded px-2 py-1">
                            Unsupported content type: &quot;{item.rawType}&quot;
                            — if you see this, please report it as a bug
                          </div>
                        )
                      default:
                        return null
                    }
                  })()}
                </ErrorBoundary>
              ))
            })()}
          </div>
          {/* Show ExitPlanMode button after all content blocks */}
          <ExitPlanModeButton
            toolCalls={message.tool_calls}
            isApproved={message.plan_approved ?? false}
            isLatestPlanRequest={isLatestPlanRequest}
            hasFollowUpMessage={hasFollowUpMessage}
            onPlanApproval={handlePlanApproval}
            onPlanApprovalYolo={handlePlanApprovalYolo}
            onClearContextApproval={handleClearContextApproval}
            onClearContextBuildApproval={handleClearContextApprovalBuild}
            onWorktreeBuildApproval={handleWorktreeBuildApproval}
            onWorktreeYoloApproval={handleWorktreeYoloApproval}
            buttonRef={isLatestPlanRequest ? approveButtonRef : undefined}
            shortcut={approveShortcut}
            shortcutYolo={approveShortcutYolo}
            shortcutClearContext={approveShortcutClearContext}
            shortcutClearContextBuild={approveShortcutClearContextBuild}
            hideApproveButtons={hideApproveButtons}
          />
        </>
      ) : (
        <>
          {/* Fallback: Show tool calls first for assistant messages (old format) */}
          {message.role === 'assistant' &&
            (message.tool_calls?.length ?? 0) > 0 &&
            !skipToolCalls && (
              <ToolCallsDisplay
                toolCalls={message.tool_calls}
                sessionId={message.session_id}
                hasFollowUpMessage={hasFollowUpMessage}
                onQuestionAnswer={onQuestionAnswer}
                onQuestionSkip={onQuestionSkip}
                isQuestionAnswered={isQuestionAnswered}
                getSubmittedAnswers={getSubmittedAnswers}
                areQuestionsSkipped={areQuestionsSkipped}
              />
            )}
          {/* Show content after tool calls */}
          {showContent && (
            <div>
              {message.role === 'assistant' &&
              hasReviewFindings(displayContent) ? (
                <>
                  <Markdown streaming={message.cancelled}>{stripFindingBlocks(displayContent)}</Markdown>
                  <ReviewFindingsList
                    findings={parseReviewFindings(displayContent)}
                    sessionId={sessionId}
                    onFix={onFixFinding}
                    onFixAll={onFixAllFindings}
                    isFixedFn={handleIsFindingFixed}
                    disabled={isSending}
                  />
                </>
              ) : message.role === 'user' ? (
                <div className="whitespace-pre-wrap break-words">
                  {displayContent}
                </div>
              ) : (
                <Markdown streaming={message.cancelled}>{displayContent}</Markdown>
              )}
            </div>
          )}
          {/* Show ExitPlanMode button after content */}
          {message.role === 'assistant' &&
            (message.tool_calls?.length ?? 0) > 0 &&
            !skipToolCalls && (
              <ExitPlanModeButton
                toolCalls={message.tool_calls}
                isApproved={message.plan_approved ?? false}
                isLatestPlanRequest={isLatestPlanRequest}
                hasFollowUpMessage={hasFollowUpMessage}
                onPlanApproval={handlePlanApproval}
                onPlanApprovalYolo={handlePlanApprovalYolo}
                onClearContextApproval={handleClearContextApproval}
                onClearContextBuildApproval={handleClearContextApprovalBuild}
                onWorktreeBuildApproval={handleWorktreeBuildApproval}
                onWorktreeYoloApproval={handleWorktreeYoloApproval}
                buttonRef={isLatestPlanRequest ? approveButtonRef : undefined}
                shortcut={approveShortcut}
                shortcutYolo={approveShortcutYolo}
                shortcutClearContext={approveShortcutClearContext}
                shortcutClearContextBuild={approveShortcutClearContextBuild}
              />
            )}
        </>
      )}

      {/* Show edited files at the bottom of assistant messages */}
      {message.role === 'assistant' &&
        (message.tool_calls?.length ?? 0) > 0 &&
        !skipToolCalls && (
          <EditedFilesDisplay
            toolCalls={message.tool_calls}
            onFileClick={onEditedFileClick}
          />
        )}

      {message.cancelled && (
        <span className="text-xs text-muted-foreground/50 italic">
          (cancelled)
        </span>
      )}
    </>
  )

  return (
    <div
      className={cn(
        'w-full min-w-0',
        message.role === 'user' && 'flex justify-end'
      )}
    >
      {message.role === 'user' ? (
        <div className="relative group flex items-start gap-1 max-w-[85%] sm:max-w-[70%]">
          {/* Copy to clipboard button - appears on hover */}
          {onCopyToInput && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyToInput}
                  className="shrink-0 mt-2 p-1 rounded cursor-pointer text-muted-foreground/0 hover:text-muted-foreground hover:bg-muted/50 group-hover:text-muted-foreground/50 transition-colors"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Copy to clipboard</TooltipContent>
            </Tooltip>
          )}
          <div
            className={cn(
              'text-foreground border border-border rounded-lg px-3 py-2 bg-muted/20 min-w-0 break-words',
              message.cancelled && 'opacity-60'
            )}
          >
            {messageBoxContent}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'text-muted-foreground w-full min-w-0 break-words',
            message.cancelled && 'opacity-60'
          )}
        >
          {messageBoxContent}
        </div>
      )}
    </div>
  )
})
