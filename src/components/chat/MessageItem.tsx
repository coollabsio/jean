import { memo, useCallback, useMemo } from 'react'
import { GitFork, Copy, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { normalizePath } from '@/lib/path-utils'
import { Markdown } from '@/components/ui/markdown'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
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
import { ThinkingBlock } from './ThinkingBlock'
import {
  parseReviewFindings,
  hasReviewFindings,
  stripFindingBlocks,
} from './review-finding-utils'
import { ReviewFindingsList } from './ReviewFindingBlock'

/** Format timestamp for tooltip display */
const formatTimestamp = (timestamp: number) => {
  return new Date(timestamp * 1000).toLocaleString()
}

/** Format relative time for action bar (e.g., "5m, 39s") */
const formatRelativeTime = (timestamp: number) => {
  const now = Date.now() / 1000
  const diff = Math.floor(now - timestamp)

  if (diff < 60) return `${diff}s`
  if (diff < 3600) {
    const m = Math.floor(diff / 60)
    const s = diff % 60
    return `${m}m, ${s}s`
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    return `${h}h, ${m}m`
  }
  const d = Math.floor(diff / 86400)
  return `${d}d`
}

/** Regex to extract image paths from message content */
const IMAGE_ATTACHMENT_REGEX =
  /\[Image attached: (.+?) - Use the Read tool to view this image\]/g

/** Regex to extract text file paths from message content */
const TEXT_FILE_ATTACHMENT_REGEX =
  /\[Text file attached: (.+?) - Use the Read tool to view this file\]/g

/** Extract image paths from message content */
function extractImagePaths(content: string): string[] {
  const paths: string[] = []
  let match
  while ((match = IMAGE_ATTACHMENT_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1])
    }
  }
  // Reset regex lastIndex for next use
  IMAGE_ATTACHMENT_REGEX.lastIndex = 0
  return paths
}

/** Extract text file paths from message content */
function extractTextFilePaths(content: string): string[] {
  const paths: string[] = []
  let match
  while ((match = TEXT_FILE_ATTACHMENT_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1])
    }
  }
  // Reset regex lastIndex for next use
  TEXT_FILE_ATTACHMENT_REGEX.lastIndex = 0
  return paths
}

/** Remove image attachment markers from content for cleaner display */
function stripImageMarkers(content: string): string {
  return content.replace(IMAGE_ATTACHMENT_REGEX, '').trim()
}

/** Remove text file attachment markers from content for cleaner display */
function stripTextFileMarkers(content: string): string {
  return content.replace(TEXT_FILE_ATTACHMENT_REGEX, '').trim()
}

/** Regex to extract file mention paths from message content */
const FILE_MENTION_REGEX =
  /\[File: (.+?) - Use the Read tool to view this file\]/g

/** Regex to extract skill paths from message content */
const SKILL_ATTACHMENT_REGEX =
  /\[Skill: (.+?) - Read and use this skill to guide your response\]/g

/** Extract file mention paths from message content */
function extractFileMentionPaths(content: string): string[] {
  const paths: string[] = []
  let match
  while ((match = FILE_MENTION_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1])
    }
  }
  // Reset regex lastIndex for next use
  FILE_MENTION_REGEX.lastIndex = 0
  return paths
}

/** Remove file mention markers from content for cleaner display */
function stripFileMentionMarkers(content: string): string {
  return content.replace(FILE_MENTION_REGEX, '').trim()
}

/** Extract skill paths from message content */
function extractSkillPaths(content: string): string[] {
  const paths: string[] = []
  let match
  while ((match = SKILL_ATTACHMENT_REGEX.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1])
    }
  }
  // Reset regex lastIndex for next use
  SKILL_ATTACHMENT_REGEX.lastIndex = 0
  return paths
}

/** Remove skill attachment markers from content for cleaner display */
function stripSkillMarkers(content: string): string {
  return content.replace(SKILL_ATTACHMENT_REGEX, '').trim()
}

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
  /** Ref to attach to approve button for visibility tracking */
  approveButtonRef?: React.RefObject<HTMLButtonElement | null>
  /** Whether Claude is currently streaming (affects last message rendering) */
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
  /** Callback when user wants to fork conversation from this message */
  onFork?: (messageId: string) => void
  /** Callback when user wants to revert conversation to this message */
  onRevert?: (messageId: string) => void
  /** Whether actions are available (assistant message, not streaming) */
  canShowActions?: boolean
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
  onFork,
  onRevert,
  canShowActions,
}: MessageItemProps) {
  // Only show Approve button for the last message with ExitPlanMode
  const isLatestPlanRequest = messageIndex === lastPlanMessageIndex

  // Check if this message has code modifications (Edit, Write, NotebookEdit tools)
  const hasCodeModifications = useMemo(() => {
    const codeModifyingTools = ['Edit', 'Write', 'NotebookEdit']
    return message.tool_calls.some(tc => codeModifyingTools.includes(tc.name))
  }, [message.tool_calls])

  // Extract image, text file, file mention, and skill paths and clean content for user messages
  const imagePaths =
    message.role === 'user' ? extractImagePaths(message.content) : []
  const textFilePaths =
    message.role === 'user' ? extractTextFilePaths(message.content) : []
  const fileMentionPaths =
    message.role === 'user' ? extractFileMentionPaths(message.content) : []
  const skillPaths =
    message.role === 'user' ? extractSkillPaths(message.content) : []
  const displayContent =
    message.role === 'user'
      ? stripSkillMarkers(
          stripFileMentionMarkers(
            stripTextFileMarkers(stripImageMarkers(message.content))
          )
        )
      : message.content

  // Show content if it's not empty
  const showContent = displayContent.trim()

  // Skip tool calls for the last assistant message if we're streaming
  // (the streaming section handles rendering those)
  const isLastMessage = messageIndex === totalMessages - 1
  const skipToolCalls =
    isSending && isLastMessage && message.role === 'assistant'

  // Show revert button only if: not the last message AND has code modifications
  const canShowRevert = !isLastMessage && hasCodeModifications

  // Stable callback for plan approval
  const handlePlanApproval = useCallback(() => {
    onPlanApproval(message.id)
  }, [onPlanApproval, message.id])

  // Stable callback for plan approval with yolo mode
  const handlePlanApprovalYolo = useCallback(() => {
    onPlanApprovalYolo?.(message.id)
  }, [onPlanApprovalYolo, message.id])

  // Stable callback for checking if finding is fixed
  const handleIsFindingFixed = useCallback(
    (findingKey: string) => isFindingFixed(sessionId, findingKey),
    [isFindingFixed, sessionId]
  )

  // Check if message has text content for showing action bar
  const hasTextContent = useMemo(() => {
    if (message.role !== 'assistant') return false
    // Check if there's direct text content
    if (showContent) return true
    // Check if there are text blocks in content_blocks
    if (message.content_blocks?.some(b => b.type === 'text')) return true
    return false
  }, [message.role, showContent, message.content_blocks])

  // Copy message text to clipboard
  const handleCopy = useCallback(() => {
    const text = message.content
    navigator.clipboard.writeText(text).then(() => {
      toast.success('Copied to clipboard')
    })
  }, [message.content])

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

      {/* Show attached file mentions (@ mentions) for user messages */}
      {fileMentionPaths.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
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
            const name = skillsIdx >= 0 && parts[skillsIdx + 1] ? parts[skillsIdx + 1] : path
            return (
              <SkillBadge
                key={`${message.id}-skill-${idx}`}
                skill={{ id: `${message.id}-skill-${idx}`, name: name ?? path, path }}
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
            {buildTimeline(
              message.content_blocks,
              message.tool_calls ?? []
            ).map(item => {
              switch (item.type) {
                case 'thinking':
                  return (
                    <ThinkingBlock
                      key={item.key}
                      thinking={item.thinking}
                      isStreaming={false}
                    />
                  )
                case 'text': {
                  // Check if text contains review findings
                  if (hasReviewFindings(item.text)) {
                    const findings = parseReviewFindings(item.text)
                    const strippedText = stripFindingBlocks(item.text)
                    return (
                      <div key={item.key}>
                        <Markdown>{strippedText}</Markdown>
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
                  return <Markdown key={item.key}>{item.text}</Markdown>
                }
                case 'task':
                  return (
                    <TaskCallInline
                      key={item.key}
                      taskToolCall={item.taskTool}
                      subToolCalls={item.subTools}
                      onFileClick={onFileClick}
                      isStreaming={false}
                    />
                  )
                case 'standalone':
                  return (
                    <ToolCallInline
                      key={item.key}
                      toolCall={item.tool}
                      onFileClick={onFileClick}
                      isStreaming={false}
                    />
                  )
                case 'stackedGroup':
                  return (
                    <StackedGroup
                      key={item.key}
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
                          ? getSubmittedAnswers(
                              message.session_id,
                              item.tool.id
                            )
                          : undefined
                      }
                    />
                  )
                }
                case 'exitPlanMode': {
                  // Render plan inline in its natural position
                  // Extract plan from this specific tool's input (not global search)
                  const toolInput = item.tool.input as { plan?: string } | undefined
                  const inlinePlan = toolInput?.plan
                  if (inlinePlan) {
                    return (
                      <PlanDisplay
                        key={item.key}
                        content={inlinePlan}
                        defaultCollapsed={
                          message.plan_approved || hasFollowUpMessage
                        }
                      />
                    )
                  }
                  // Fall back to file-based plan (Write to ~/.claude/plans/*.md)
                  const planFilePath = findPlanFilePath(
                    message.tool_calls ?? []
                  )
                  if (!planFilePath) return null
                  return (
                    <PlanDisplay
                      key={item.key}
                      filePath={planFilePath}
                      defaultCollapsed={
                        message.plan_approved || hasFollowUpMessage
                      }
                    />
                  )
                }
                default:
                  return null
              }
            })}
          </div>
          {/* Show ExitPlanMode button after all content blocks */}
          <ExitPlanModeButton
            toolCalls={message.tool_calls}
            isApproved={message.plan_approved ?? false}
            isLatestPlanRequest={isLatestPlanRequest}
            hasFollowUpMessage={hasFollowUpMessage}
            onPlanApproval={handlePlanApproval}
            onPlanApprovalYolo={handlePlanApprovalYolo}
            buttonRef={isLatestPlanRequest ? approveButtonRef : undefined}
            shortcut={approveShortcut}
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
                  <Markdown>{stripFindingBlocks(displayContent)}</Markdown>
                  <ReviewFindingsList
                    findings={parseReviewFindings(displayContent)}
                    sessionId={sessionId}
                    onFix={onFixFinding}
                    onFixAll={onFixAllFindings}
                    isFixedFn={handleIsFindingFixed}
                    disabled={isSending}
                  />
                </>
              ) : (
                <Markdown>{displayContent}</Markdown>
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
                buttonRef={isLatestPlanRequest ? approveButtonRef : undefined}
                shortcut={approveShortcut}
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

  // User message tooltip content
  const userMessageTooltip = (
    <TooltipContent side="left" align="start" className="text-xs">
      <div className="space-y-0.5">
        <div>
          <span className="text-muted font-bold">Model:</span>{' '}
          {message.model ?? 'N/A'}
        </div>
        <div>
          <span className="text-muted font-bold">Think:</span>{' '}
          {message.thinking_level ?? 'N/A'}
        </div>
        <div>
          <span className="text-muted font-bold">Mode:</span>{' '}
          {message.execution_mode ?? 'N/A'}
        </div>
        <div>
          <span className="text-muted font-bold">Time:</span>{' '}
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </TooltipContent>
  )

  return (
    <div
      className={cn(
        'w-full min-w-0',
        message.role === 'user' && 'flex justify-end'
      )}
    >
      {message.role === 'user' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'text-foreground border border-border rounded-lg px-3 py-2 max-w-[70%] bg-muted/20 min-w-0 break-words',
                message.cancelled && 'opacity-60'
              )}
            >
              {messageBoxContent}
            </div>
          </TooltipTrigger>
          {userMessageTooltip}
        </Tooltip>
      ) : (
        <div
          className={cn(
            'relative group text-muted-foreground w-full min-w-0 break-words',
            message.cancelled && 'opacity-60'
          )}
        >
          {messageBoxContent}
          {/* Action bar - shown for messages with text content */}
          {hasTextContent && canShowActions && (
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground/60">
              <span>{formatRelativeTime(message.timestamp)}</span>
              <span className="text-muted-foreground/30">·</span>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="p-1 hover:text-foreground transition-colors cursor-pointer"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Copy to clipboard
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onFork?.(message.id)}
                      className="p-1 hover:text-foreground transition-colors cursor-pointer"
                    >
                      <GitFork className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Fork conversation
                  </TooltipContent>
                </Tooltip>
                {canShowRevert && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onRevert?.(message.id)}
                        className="p-1 hover:text-foreground transition-colors cursor-pointer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      Revert to this point
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
