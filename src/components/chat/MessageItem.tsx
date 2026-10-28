import { memo, useCallback, useMemo, useState } from 'react'
import { AgentMessageFromRow } from '@/components/agents/AgentMessageLink'
import { parseAgentSentMessage } from '@/components/agents/agent-messages'
import { Copy } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { PILL_BUBBLE_CLASS, ReplyBubble } from './ReplyBubble'
import { ChatContinuedNotice } from './ChatContinuedNotice'
import { parseInlineNumberedQuestion } from './inline-question-utils'
import { InlineQuestionOptions } from './InlineQuestionOptions'
import { cn } from '@/lib/utils'
import { normalizePath } from '@/lib/path-utils'
import { copyToClipboard } from '@/lib/clipboard'
import { Markdown } from '@/components/ui/markdown'
import { MessageThreadContextMenu } from './message-thread-context-menu'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'
import { AskUserQuestion } from './AskUserQuestion'
import { ToolCallInline, TaskCallInline, StackedGroup } from './ToolCallInline'
import {
  buildTimeline,
  findPlanFilePath,
  getIntroTextBeforeDuplicatePlan,
  getPlanTextBlockIndicesToHide,
  isDuplicatePlanTextBlock,
  resolvePlanContent,
} from './tool-call-utils'
import { PlanDisplay } from './PlanFileDisplay'
import { ImageLightbox } from './ImageLightbox'
import { parseServerResourceKey } from '@/lib/server-resource'
import { TextFileLightbox } from './TextFileLightbox'
import { FileMentionBadge } from './FileMentionBadge'
import { SkillBadge } from './SkillBadge'
import { ToolCallsDisplay } from './ToolCallsDisplay'
import { ExitPlanModeButton } from './ExitPlanModeButton'
import { Button } from '@/components/ui/button'
import {
  CheckpointTurnRestoreButton,
  isUserTurnFinished,
  turnHasFileEdits,
} from './CheckpointTurnRestoreButton'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { ThinkingBlock } from './ThinkingBlock'
import { SteeredPromptGroup } from './SteeredPromptGroup'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { logger } from '@/lib/logger'
import { MessageTiming } from './MessageTiming'
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
  isAgentUpdateMessage,
  isChatContinuedMessage,
} from './message-content-utils'
import {
  getAskUserQuestions,
  hasQuestionAnswerOutput,
  normalizeQuestionMultipleField,
} from '@/types/chat'
import { MessageSettingsBadges } from '@/components/chat/MessageSettingsBadges'
import type { ApprovalModelOverride } from './ApprovalModelSubmenu'
import { useUIStore } from '@/store/ui-store'

const EMPTY_PATHS: string[] = []

// Per-message chrome (settings, copy, restore, duration) appears on hover or
// keyboard focus. Touch devices have no hover, so it stays visible there.
const USER_HOVER_REVEAL =
  'transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100'
// Touch devices have no hover: details stay hidden until the prompt is tapped
const USER_TAP_HIDDEN = '[@media(pointer:coarse)]:hidden'
const ASSISTANT_HOVER_REVEAL =
  'transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/message:opacity-100 [@media(pointer:fine)]:group-focus-within/message:opacity-100'

function CopyIconButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className="text-muted-foreground hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

interface MessageItemProps {
  /** The message to render */
  message: ChatMessage
  /**
   * Stable accessor for the full session message list, used to compute
   * "subsequent edits" lazily when a diff is opened. Passing a stable
   * function (not the array) preserves this row's memoization.
   */
  getMessages?: () => ChatMessage[]
  /** Index of this message in the message list */
  messageIndex: number
  /** Whether this is the last message in the list */
  isLastMessage: boolean
  /** Index of the last plan message (for approve button logic) */
  lastPlanMessageIndex: number
  /** Pre-computed: does a user message follow this one? */
  hasFollowUpMessage: boolean
  /** Session ID for this message */
  sessionId: string
  /** Worktree path for resolving file mentions */
  worktreePath: string
  /** Worktree id for checkpoint restore (modal + main window) */
  worktreeId?: string | null
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
  onClearContextApproval?: (
    messageId: string,
    override?: ApprovalModelOverride
  ) => void
  /** Callback for clear context approval (new session with plan in build mode) */
  onClearContextApprovalBuild?: (
    messageId: string,
    override?: ApprovalModelOverride
  ) => void
  /** Callback for worktree approval (new worktree with plan in build mode) */
  onWorktreeBuildApproval?: (
    messageId: string,
    override?: ApprovalModelOverride
  ) => void
  /** Callback for worktree approval (new worktree with plan in yolo mode) */
  onWorktreeYoloApproval?: (
    messageId: string,
    override?: ApprovalModelOverride
  ) => void
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
  /** Hide the built-in cancelled marker when a parent compact row renders it externally */
  hideCancelledIndicator?: boolean
  /** Duration of this assistant message in ms (computed from user→assistant timestamp delta) */
  durationMs?: number | null
  /** Render the assistant reply in a bubble (agent chat) */
  bubble?: boolean
  /** Agent chat: hide backend, model, mode, and effort under the user prompt and show it as a pill */
  hideSettingsBadges?: boolean
  /** Sends a user message (answers to inline numbered questions) */
  onSendAnswer?: (text: string) => void
}

/**
 * Renders a single chat message (user or assistant)
 * Memoized to prevent re-renders when sibling messages change
 */
export const MessageItem = memo(function MessageItem({
  message,
  getMessages,
  messageIndex,
  isLastMessage,
  lastPlanMessageIndex,
  hasFollowUpMessage,
  sessionId,
  worktreePath,
  worktreeId = null,
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
  onFixFinding,
  onFixAllFindings,
  isQuestionAnswered,
  getSubmittedAnswers,
  areQuestionsSkipped,
  isFindingFixed,
  onCopyToInput,
  hideApproveButtons,
  hideCancelledIndicator,
  durationMs,
  bubble = false,
  hideSettingsBadges = false,
  onSendAnswer,
}: MessageItemProps) {
  const zenMode = useUIStore(state => state.zenMode)
  // Only show Approve button for the last message with ExitPlanMode
  const isLatestPlanRequest = messageIndex === lastPlanMessageIndex

  // Extract image, text file, file mention, and skill paths and clean content for user messages
  const {
    imagePaths,
    textFilePaths,
    fileMentionPaths,
    directoryMentionPaths,
    skillPaths,
    displayContent,
  } = useMemo(() => {
    if (message.role !== 'user') {
      return {
        imagePaths: EMPTY_PATHS,
        textFilePaths: EMPTY_PATHS,
        fileMentionPaths: EMPTY_PATHS,
        directoryMentionPaths: EMPTY_PATHS,
        skillPaths: EMPTY_PATHS,
        displayContent: message.content,
      }
    }
    return {
      imagePaths: extractImagePaths(message.content),
      textFilePaths: extractTextFilePaths(message.content),
      fileMentionPaths: extractFileMentionPaths(message.content),
      directoryMentionPaths: extractDirectoryMentionPaths(message.content),
      skillPaths: extractSkillPaths(message.content),
      displayContent: stripAllMarkers(message.content),
    }
  }, [message.role, message.content])
  const messageServerId = parseServerResourceKey(
    worktreeId ?? sessionId
  )?.serverId
  const assistantResponse = useMemo(
    () =>
      message.role === 'assistant'
        ? message.content.trim() ||
          (message.content_blocks ?? [])
            .flatMap(block => (block.type === 'text' ? [block.text] : []))
            .join('\n')
            .trim()
        : '',
    [message.role, message.content, message.content_blocks]
  )
  // Numbered question asked as text: answerable until the user replies
  const inlineQuestion = useMemo(
    () =>
      isLastMessage && !hasFollowUpMessage && onSendAnswer
        ? parseInlineNumberedQuestion(assistantResponse)
        : null,
    [isLastMessage, hasFollowUpMessage, onSendAnswer, assistantResponse]
  )
  // Show content if it's not empty
  const showContent = displayContent.trim()

  // Skip tool calls for the last assistant message if we're streaming
  // (the streaming section handles rendering those)
  const skipToolCalls =
    isSending && isLastMessage && message.role === 'assistant'
  const shouldRenderTimeline =
    message.role === 'assistant' &&
    !!message.content_blocks &&
    message.content_blocks.length > 0 &&
    !skipToolCalls

  // Stable callback for plan approval
  const handlePlanApproval = useCallback(() => {
    onPlanApproval(message.id)
  }, [onPlanApproval, message.id])

  // Stable callback for plan approval with yolo mode
  const handlePlanApprovalYolo = useCallback(() => {
    onPlanApprovalYolo?.(message.id)
  }, [onPlanApprovalYolo, message.id])

  // Stable callback for clear context approval
  const handleClearContextApproval = useCallback(
    (override?: ApprovalModelOverride) => {
      onClearContextApproval?.(message.id, override)
    },
    [onClearContextApproval, message.id]
  )

  // Stable callback for clear context build approval
  const handleClearContextApprovalBuild = useCallback(
    (override?: ApprovalModelOverride) => {
      onClearContextApprovalBuild?.(message.id, override)
    },
    [onClearContextApprovalBuild, message.id]
  )

  // Stable callback for worktree build approval
  const handleWorktreeBuildApproval = useCallback(
    (override?: ApprovalModelOverride) => {
      onWorktreeBuildApproval?.(message.id, override)
    },
    [onWorktreeBuildApproval, message.id]
  )

  // Stable callback for worktree yolo approval
  const handleWorktreeYoloApproval = useCallback(
    (override?: ApprovalModelOverride) => {
      onWorktreeYoloApproval?.(message.id, override)
    },
    [onWorktreeYoloApproval, message.id]
  )

  // Stable callback for checking if finding is fixed
  const handleIsFindingFixed = useCallback(
    (findingKey: string) => isFindingFixed(sessionId, findingKey),
    [isFindingFixed, sessionId]
  )

  // Stable callback for copying message to input
  const handleCopyToInput = useCallback(() => {
    onCopyToInput?.(message)
  }, [onCopyToInput, message])

  const [showUserDetails, setShowUserDetails] = useState(false)
  const handleUserBubbleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return
    setShowUserDetails(prev => !prev)
  }, [])

  const userTurnHasFileEdits = useMemo(() => {
    if (message.role !== 'user' || !getMessages) return false
    return turnHasFileEdits(getMessages(), messageIndex)
  }, [message.role, getMessages, messageIndex])

  const showSettingsBadges = !hideSettingsBadges && Boolean(message.model)

  // Only offer Restore after the agent turn finishes (not mid-stream).
  const showTurnRestore = useMemo(() => {
    if (!userTurnHasFileEdits || !getMessages) return false
    return isUserTurnFinished(getMessages(), messageIndex, isSending)
  }, [userTurnHasFileEdits, getMessages, messageIndex, isSending])

  const handleCopyAssistantResponse = useCallback(() => {
    if (!assistantResponse) return

    void copyToClipboard(assistantResponse)
      .then(() => toast.success('Response copied to clipboard'))
      .catch(() => toast.error('Failed to copy response'))
  }, [assistantResponse])

  // Content for the message box (shared between user and assistant)
  const {
    resolvedPlan,
    hiddenPlanTextBlockIndices,
    fallbackPrePlanText,
    isDuplicateAssistantPlanContent,
  } = useMemo(() => {
    const resolved = resolvePlanContent({
      toolCalls: message.tool_calls ?? [],
      messageContent: message.content,
      contentBlocks: message.content_blocks,
    })
    return {
      resolvedPlan: resolved,
      hiddenPlanTextBlockIndices: getPlanTextBlockIndicesToHide(
        message.content_blocks,
        resolved.content
      ),
      fallbackPrePlanText:
        message.role === 'assistant'
          ? getIntroTextBeforeDuplicatePlan(displayContent, resolved.content)
          : null,
      isDuplicateAssistantPlanContent:
        message.role === 'assistant' &&
        isDuplicatePlanTextBlock(displayContent, resolved.content),
    }
  }, [
    message.tool_calls,
    message.content,
    message.content_blocks,
    message.role,
    displayContent,
  ])

  // Timeline + per-text-item derivations (hidden plan text, review findings,
  // last visible text). Only rebuilt when the message content changes.
  const timelineData = useMemo(() => {
    if (!shouldRenderTimeline || !message.content_blocks) return null
    const contentBlocks = message.content_blocks
    let timeline
    try {
      timeline = buildTimeline(contentBlocks, message.tool_calls ?? [])
    } catch (e) {
      logger.error('Failed to build timeline for message', {
        messageId: message.id,
        error: e,
      })
      return { failed: true as const }
    }
    // First index of each text block's content (equivalent to findIndex)
    const firstTextBlockIndex = new Map<string, number>()
    contentBlocks.forEach((block, idx) => {
      if (block.type === 'text' && !firstTextBlockIndex.has(block.text)) {
        firstTextBlockIndex.set(block.text, idx)
      }
    })
    let lastVisibleTextKey: string | undefined
    const textInfo = timeline.map(item => {
      if (item.type !== 'text') return null
      const textBlockIndex = firstTextBlockIndex.get(item.text)
      const hidden =
        (textBlockIndex !== undefined &&
          hiddenPlanTextBlockIndices.has(textBlockIndex)) ||
        isDuplicatePlanTextBlock(item.text, resolvedPlan.content)
      if (hidden) return { hidden: true as const }
      lastVisibleTextKey = item.key
      if (!hasReviewFindings(item.text)) {
        return { hidden: false as const, review: null }
      }
      return {
        hidden: false as const,
        review: {
          findings: parseReviewFindings(item.text),
          strippedText: stripFindingBlocks(item.text),
        },
      }
    })
    const hasRenderedTextItem = timeline.some(item => item.type === 'text')
    return {
      failed: false as const,
      timeline,
      textInfo,
      lastVisibleTextKey,
      hasRenderedPlanItem: timeline.some(item => item.type === 'exitPlanMode'),
      fallbackAssistantIntro: !hasRenderedTextItem
        ? (fallbackPrePlanText ??
          (!isDuplicatePlanTextBlock(displayContent, resolvedPlan.content)
            ? displayContent
            : null))
        : null,
    }
  }, [
    shouldRenderTimeline,
    message.content_blocks,
    message.tool_calls,
    message.id,
    hiddenPlanTextBlockIndices,
    resolvedPlan.content,
    fallbackPrePlanText,
    displayContent,
  ])

  // Review findings for the non-timeline (legacy) assistant content path
  const displayContentReview = useMemo(() => {
    if (
      shouldRenderTimeline ||
      message.role !== 'assistant' ||
      !hasReviewFindings(displayContent)
    ) {
      return null
    }
    return {
      findings: parseReviewFindings(displayContent),
      strippedText: stripFindingBlocks(displayContent),
    }
  }, [shouldRenderTimeline, message.role, displayContent])
  const shouldRenderDisplayContent =
    Boolean(showContent) && !isDuplicateAssistantPlanContent
  const durationBadge =
    message.role === 'assistant' && durationMs != null && durationMs > 0 ? (
      <span
        className={cn(
          'mt-1 block min-h-4 text-xs leading-4 text-muted-foreground/40 tabular-nums',
          ASSISTANT_HOVER_REVEAL
        )}
      >
        <MessageTiming durationMs={durationMs} timestamp={message.timestamp} />
      </span>
    ) : null

  const messageBoxContent = (
    <>
      {/* Show attached images for user messages */}
      {imagePaths.length > 0 && (
        <div data-attachments className="flex flex-wrap gap-2 mb-2">
          {imagePaths.map((path, idx) => (
            <ImageLightbox
              key={`${message.id}-img-${idx}`}
              src={path}
              serverId={
                messageServerId === 'local' ? undefined : messageServerId
              }
              alt={`Attached image ${idx + 1}`}
              thumbnailClassName="h-20 max-w-40 object-contain rounded border border-border/50 cursor-pointer hover:border-foreground/20 transition-colors"
            />
          ))}
        </div>
      )}

      {/* Show attached text files for user messages */}
      {textFilePaths.length > 0 && (
        <div data-attachments className="flex flex-wrap gap-2 mb-2">
          {textFilePaths.map((path, idx) => (
            <TextFileLightbox
              key={`${message.id}-txt-${idx}`}
              path={path}
              serverId={
                messageServerId === 'local' ? undefined : messageServerId
              }
            />
          ))}
        </div>
      )}

      {/* Show attached file and directory mentions (@ mentions) for user messages */}
      {(fileMentionPaths.length > 0 || directoryMentionPaths.length > 0) && (
        <div data-attachments className="flex flex-wrap gap-2 mb-2">
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
              serverId={
                messageServerId === 'local' ? undefined : messageServerId
              }
            />
          ))}
        </div>
      )}

      {/* Show attached skills (/ mentions) for user messages */}
      {skillPaths.length > 0 && (
        <div data-attachments className="flex flex-wrap gap-2 mb-2">
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
      {shouldRenderTimeline && timelineData ? (
        <>
          {/* Build timeline preserving order of text and tools */}
          <div className="space-y-4">
            {(() => {
              if (timelineData.failed) {
                return (
                  <div className="text-sm text-muted-foreground italic">
                    <span>[Message could not be rendered]</span>
                    {message.content && (
                      <Markdown
                        streaming={message.cancelled}
                        messageId={message.id}
                        sessionId={sessionId}
                      >
                        {message.content}
                      </Markdown>
                    )}
                  </div>
                )
              }
              const {
                timeline,
                textInfo,
                lastVisibleTextKey,
                hasRenderedPlanItem,
                fallbackAssistantIntro,
              } = timelineData
              return (
                <>
                  {fallbackAssistantIntro && (
                    <>
                      <Markdown
                        streaming={message.cancelled ?? false}
                        messageId={message.id}
                        sessionId={sessionId}
                      >
                        {fallbackAssistantIntro}
                      </Markdown>
                      {!lastVisibleTextKey && durationBadge}
                    </>
                  )}
                  {timeline.map((item, itemIdx) => (
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
                            const info = textInfo[itemIdx]
                            if (!info || info.hidden) {
                              return null
                            }
                            if (info.review) {
                              const { findings, strippedText } = info.review
                              return (
                                <div>
                                  <Markdown
                                    streaming={message.cancelled ?? false}
                                    messageId={message.id}
                                    sessionId={sessionId}
                                  >
                                    {strippedText}
                                  </Markdown>
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
                                  {item.key === lastVisibleTextKey &&
                                    durationBadge}
                                </div>
                              )
                            }
                            return (
                              <>
                                <Markdown
                                  streaming={message.cancelled ?? false}
                                  messageId={message.id}
                                  sessionId={sessionId}
                                >
                                  {item.text}
                                </Markdown>
                                {item.key === lastVisibleTextKey &&
                                  durationBadge}
                              </>
                            )
                          }
                          case 'userInput':
                            return (
                              <SteeredPromptGroup
                                texts={item.texts}
                                worktreePath={worktreePath}
                                serverId={
                                  messageServerId === 'local'
                                    ? undefined
                                    : messageServerId
                                }
                              />
                            )
                          case 'task':
                            return (
                              <TaskCallInline
                                taskToolCall={item.taskTool}
                                subToolCalls={item.subTools}
                                allToolCalls={message.tool_calls ?? []}
                                nestedSubTools={item.nestedSubTools}
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
                            // Question is answered if: (1) follow-up user message exists (Claude),
                            // (2) ephemeral Zustand state says so, or (3) tool has output (OpenCode —
                            // the tool_result is persisted in the message, surviving reloads)
                            const isAnswered =
                              hasFollowUpMessage ||
                              isQuestionAnswered(
                                message.session_id,
                                item.tool.id
                              ) ||
                              hasQuestionAnswerOutput(item.tool.output)
                            const normalizedQuestions =
                              normalizeQuestionMultipleField(
                                (getAskUserQuestions(item.tool.input) ??
                                  []) as (Question & { multiple?: boolean })[]
                              )
                            return (
                              <AskUserQuestion
                                toolCallId={item.tool.id}
                                questions={normalizedQuestions}
                                introText={item.introText}
                                hasFollowUpMessage={
                                  hasFollowUpMessage ||
                                  hasQuestionAnswerOutput(item.tool.output)
                                }
                                isSkipped={areQuestionsSkipped(
                                  message.session_id
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
                                        message.session_id,
                                        item.tool.id
                                      )
                                    : undefined
                                }
                                toolOutput={item.tool.output ?? undefined}
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
                            const inlinePlan = resolvePlanContent({
                              toolCalls: [item.tool],
                              messageContent: message.content,
                              contentBlocks: message.content_blocks,
                            }).content
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
                  ))}
                  {resolvedPlan.content && !hasRenderedPlanItem && (
                    <PlanDisplay
                      content={resolvedPlan.content}
                      defaultCollapsed={
                        message.plan_approved || hasFollowUpMessage
                      }
                    />
                  )}
                </>
              )
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
            sessionId={sessionId}
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
          {message.role === 'assistant' && fallbackPrePlanText && (
            <>
              <Markdown
                streaming={message.cancelled ?? false}
                messageId={message.id}
                sessionId={sessionId}
              >
                {fallbackPrePlanText}
              </Markdown>
              {durationBadge}
            </>
          )}
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
          {message.role === 'assistant' &&
            resolvedPlan.content &&
            (message.tool_calls?.length ?? 0) > 0 &&
            !skipToolCalls && (
              <PlanDisplay
                content={resolvedPlan.content}
                defaultCollapsed={message.plan_approved || hasFollowUpMessage}
              />
            )}
          {/* Show content after tool calls */}
          {shouldRenderDisplayContent && (
            <div>
              {displayContentReview ? (
                <>
                  <Markdown
                    streaming={message.cancelled ?? false}
                    messageId={message.id}
                    sessionId={sessionId}
                  >
                    {displayContentReview.strippedText}
                  </Markdown>
                  <ReviewFindingsList
                    findings={displayContentReview.findings}
                    sessionId={sessionId}
                    onFix={onFixFinding}
                    onFixAll={onFixAllFindings}
                    isFixedFn={handleIsFindingFixed}
                    disabled={isSending}
                  />
                  {!fallbackPrePlanText && durationBadge}
                </>
              ) : message.role === 'user' ? (
                <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {displayContent}
                </div>
              ) : (
                <>
                  <Markdown
                    streaming={message.cancelled ?? false}
                    messageId={message.id}
                    sessionId={sessionId}
                  >
                    {displayContent}
                  </Markdown>
                  {!fallbackPrePlanText && durationBadge}
                </>
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
                sessionId={sessionId}
                buttonRef={isLatestPlanRequest ? approveButtonRef : undefined}
                shortcut={approveShortcut}
                shortcutYolo={approveShortcutYolo}
                shortcutClearContext={approveShortcutClearContext}
                shortcutClearContextBuild={approveShortcutClearContextBuild}
              />
            )}
        </>
      )}

      {inlineQuestion && onSendAnswer && !skipToolCalls && (
        <InlineQuestionOptions
          question={inlineQuestion.question}
          options={inlineQuestion.options}
          disabled={isSending}
          onSend={onSendAnswer}
        />
      )}

      {message.cancelled && !hideCancelledIndicator && (
        <span className="text-xs text-muted-foreground/50 italic">
          (cancelled)
        </span>
      )}
    </>
  )

  const messageRow = (
    <div
      className={cn(
        'w-full min-w-0',
        message.role === 'user' && 'flex justify-end'
      )}
    >
      {message.role === 'user' ? (
        <div className="group flex max-w-[85%] min-w-0 flex-col items-end gap-1 sm:max-w-[70%]">
          <div
            onClick={handleUserBubbleClick}
            className={cn(
              'max-w-full',
              hideSettingsBadges
                ? cn(
                    PILL_BUBBLE_CLASS,
                    '[--bubble-bg:var(--agent-accent,var(--muted))] bg-(--bubble-bg)',
                    // Agent-colored bubbles are strong shades: use white text
                    '[--bubble-fg:var(--agent-accent-fg,var(--foreground))] text-(--bubble-fg) [&_a]:text-inherit',
                    // Attachments: the bubble color, a bit darker
                    '[&_[data-attachments]>*]:border-transparent [&_[data-attachments]>*]:bg-[color-mix(in_oklab,var(--bubble-bg)_80%,black)]'
                  )
                : 'min-w-0 break-words [overflow-wrap:anywhere] rounded-lg border border-border/20 bg-muted/20 px-3 py-2 text-foreground'
            )}
          >
            {messageBoxContent}
          </div>
          {/* Settings and actions under the prompt, revealed on hover/focus
              (restore only after finished turns with file edits) */}
          {!zenMode &&
            (showSettingsBadges || showTurnRestore || onCopyToInput) && (
              <div
                className={cn(
                  'flex shrink-0 items-center gap-1 pr-0.5',
                  USER_HOVER_REVEAL,
                  !showUserDetails && USER_TAP_HIDDEN
                )}
              >
                {showSettingsBadges && message.model && (
                  <MessageSettingsBadges
                    model={message.model}
                    executionMode={message.execution_mode}
                    thinkingLevel={message.thinking_level}
                    effortLevel={message.effort_level}
                    provider={message.custom_profile_name}
                    isCursor={message.model.startsWith('cursor/')}
                  />
                )}
                {showTurnRestore && (
                  <CheckpointTurnRestoreButton
                    userMessageId={message.id}
                    worktreeId={worktreeId}
                    hasFileEdits
                    className="mt-0"
                  />
                )}
                {onCopyToInput && (
                  <CopyIconButton
                    label="Copy prompt"
                    onClick={handleCopyToInput}
                  />
                )}
              </div>
            )}
        </div>
      ) : (
        <div className="group/message group relative text-foreground/90 w-full min-w-0 break-words">
          {bubble ? (
            <ReplyBubble>{messageBoxContent}</ReplyBubble>
          ) : (
            messageBoxContent
          )}
          {!zenMode && assistantResponse && (
            <div
              className={cn('mt-1 flex justify-end', ASSISTANT_HOVER_REVEAL)}
            >
              <CopyIconButton
                label="Copy response"
                onClick={handleCopyAssistantResponse}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )

  // Custom right-click menu replaces the unusable browser default on the thread.
  if (message.role === 'user') {
    // Jean's automatic agent updates are for the agent only; show its reply.
    if (isAgentUpdateMessage(message.content)) return null
    if (isChatContinuedMessage(message.content))
      return <ChatContinuedNotice content={message.content} />
    // A message from an agent: one line that opens the conversation
    const agentSent = parseAgentSentMessage(message.content)
    if (agentSent)
      return (
        <AgentMessageFromRow
          sent={agentSent}
          sessionId={sessionId}
          worktreeId={worktreeId}
          worktreePath={worktreePath}
        />
      )
    return (
      <MessageThreadContextMenu
        messageText={displayContent}
        copyMessageLabel="Copy message"
        onCopyMessage={onCopyToInput ? handleCopyToInput : undefined}
      >
        {messageRow}
      </MessageThreadContextMenu>
    )
  }

  return (
    <MessageThreadContextMenu
      messageText={assistantResponse}
      copyMessageLabel="Copy response"
      onCopyMessage={
        assistantResponse ? handleCopyAssistantResponse : undefined
      }
    >
      {messageRow}
    </MessageThreadContextMenu>
  )
})
