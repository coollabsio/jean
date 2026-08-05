import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronRight, Loader2, Activity, Brain } from 'lucide-react'
import { Markdown } from '@/components/ui/markdown'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type {
  ChatMessage,
  ContentBlock,
  Question,
  QuestionAnswer,
  ReviewFinding,
  ToolCall,
} from '@/types/chat'
import {
  getAskUserQuestions,
  hasQuestionAnswerOutput,
  isAskUserQuestion,
  isPlanToolCall,
  normalizeQuestionMultipleField,
} from '@/types/chat'
import { MessageItem } from './MessageItem'
import { getProviderChangeBeforeMessage } from './message-settings-labels'
import { ProviderChangeSeparator } from './ProviderChangeSeparator'
import { EditedFilesDisplay } from './EditedFilesDisplay'
import { AskUserQuestion } from './AskUserQuestion'
import { SteeredPromptGroup } from './SteeredPromptGroup'
import { buildTimeline, coalesceContentBlocks } from './tool-call-utils'
import { formatDuration, getAssistantDurationMs } from './time-utils'
import {
  TOOL_CALL_ROW_CLASS,
  TOOL_CALL_DETAIL_PILL_CLASS,
} from './ToolCallInline'
import type { VirtualizedMessageListHandle } from './VirtualizedMessageList'
import {
  capturePrependScrollAnchor,
  restorePrependScrollAnchor,
  type PrependScrollAnchor,
} from './message-scroll-anchor'
import {
  RECAP_HEADING_RE,
  extractRecapSection,
  stripRecapFromMessage,
} from './recap-utils'

const SCROLL_THRESHOLD = 300

interface CompactMessageListProps {
  messages: ChatMessage[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  totalMessages: number
  lastPlanMessageIndex: number
  sessionId: string
  worktreePath: string
  worktreeId?: string | null
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
  shouldScrollToBottom?: boolean
  onScrollToBottomHandled?: () => void
  completedDurationMs?: number | null
  hasOlderOnDisk?: boolean
  isLoadingOlder?: boolean
  onLoadOlderRuns?: () => void
  loadedRunStartIndex?: number
  hiddenPromptCount?: number
  onShowHiddenPrompts?: () => void
}

type RenderItem =
  | { kind: 'message'; message: ChatMessage; globalIndex: number }
  | {
      kind: 'compact'
      messages: { message: ChatMessage; globalIndex: number }[]
      key: string
      latestText: string | null
    }
  | { kind: 'question'; message: ChatMessage; globalIndex: number }
  | {
      kind: 'steered'
      texts: string[]
      key: string
      messageId: string
      globalIndex: number
    }

/**
 * Returns true if an assistant message should always render in full
 * (contains a plan tool call) under compact mode.
 */
function messageContainsPlan(message: ChatMessage): boolean {
  return Boolean(message.tool_calls?.some(isPlanToolCall))
}

function messageContainsQuestion(message: ChatMessage): boolean {
  return Boolean(message.tool_calls?.some(isAskUserQuestion))
}

type SteerSegment =
  | { kind: 'blocks'; message: ChatMessage }
  | { kind: 'steered'; texts: string[]; key: string }

/**
 * Splits an assistant message at mid-turn steered user prompts (Codex
 * `turn/steer`, `user_input` blocks) so the compact view can interleave them
 * chronologically: activity before a steer renders before its bubble, and
 * activity after the steer renders after it. Returns null when the message
 * contains no steered input.
 */
function splitMessageAtSteeredInputs(
  message: ChatMessage
): SteerSegment[] | null {
  const blocks = message.content_blocks ?? []
  if (!blocks.some(block => block.type === 'user_input')) return null

  const segments: SteerSegment[] = []
  let current: ContentBlock[] = []
  let part = 0

  const flushBlocks = () => {
    if (current.length === 0) return
    const toolIds = new Set(
      current.flatMap(b => (b.type === 'tool_use' ? [b.tool_call_id] : []))
    )
    const text = current
      .flatMap(b => (b.type === 'text' ? [b.text] : []))
      .join('')
    segments.push({
      kind: 'blocks',
      message: {
        ...message,
        id: `${message.id}-part-${part++}`,
        content: text,
        content_blocks: current,
        tool_calls: (message.tool_calls ?? []).filter(tc => toolIds.has(tc.id)),
      },
    })
    current = []
  }

  blocks.forEach((block, index) => {
    if (block.type === 'user_input') {
      flushBlocks()
      if (block.text.trim()) {
        // Consecutive steered prompts merge into one connected group
        const last = segments[segments.length - 1]
        if (last && last.kind === 'steered') {
          last.texts.push(block.text)
        } else {
          segments.push({
            kind: 'steered',
            texts: [block.text],
            key: `steered-${message.id}-${index}`,
          })
        }
      }
    } else {
      current.push(block)
    }
  })
  flushBlocks()

  return segments
}

function isPureTextAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  if ((message.tool_calls?.length ?? 0) > 0) return false

  const blocks = message.content_blocks ?? []
  if (blocks.some(block => block.type !== 'text')) return false

  const blockText = blocks
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('')

  return Boolean(blockText.trim() || message.content?.trim())
}

/**
 * Returns the latest assistant prose text in a compact group as plain text.
 * Walks newest → oldest and returns the first non-empty result. If the latest
 * message contains a `## Recap` section, only that section is returned so the
 * compact view surfaces the wrap-up instead of replaying the whole turn.
 */
function findLatestAssistantText(
  group: { message: ChatMessage }[]
): string | null {
  for (let g = group.length - 1; g >= 0; g--) {
    const message = group[g]?.message
    if (!message || message.role !== 'assistant') continue

    const blocks = coalesceContentBlocks(message.content_blocks ?? [])
    const texts: string[] = []
    for (const block of blocks) {
      if (block?.type === 'text' && block.text.trim()) {
        texts.push(block.text)
      }
    }
    if (texts.length === 0 && message.content?.trim()) {
      texts.push(message.content)
    }
    if (texts.length === 0) continue

    const combined = texts.join('\n\n')
    if (!combined.trim()) continue
    const recap = extractRecapSection(combined)
    if (recap) return recap
    return texts[texts.length - 1] ?? null
  }
  return null
}

/**
 * Returns a clone of `message` with all AskUserQuestion tool calls / blocks
 * removed so {@link MessageItem} can render the surrounding timeline without
 * duplicating the question UI we render separately.
 */
function stripQuestionsFromMessage(message: ChatMessage): ChatMessage {
  const questionIds = new Set(
    (message.tool_calls ?? []).flatMap(tc =>
      isAskUserQuestion(tc) ? [tc.id] : []
    )
  )
  if (questionIds.size === 0) return message
  return {
    ...message,
    tool_calls: (message.tool_calls ?? []).filter(
      tc => !questionIds.has(tc.id)
    ),
    content_blocks: message.content_blocks
      ? message.content_blocks.filter(
          b => b.type !== 'tool_use' || !questionIds.has(b.tool_call_id)
        )
      : undefined,
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function truncatePath(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  if (oneLine.includes('/')) return `…${oneLine.slice(-(max - 1))}`
  return `${oneLine.slice(0, max - 1)}…`
}

function summarizeToolCall(tc: ToolCall): { label: string; detail?: string } {
  const input = (tc.input ?? {}) as Record<string, unknown>
  const filePath =
    typeof input.file_path === 'string' ? input.file_path : undefined
  const path = typeof input.path === 'string' ? input.path : undefined
  const command = typeof input.command === 'string' ? input.command : undefined
  const url = typeof input.url === 'string' ? input.url : undefined
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined
  const description =
    typeof input.description === 'string' ? input.description : undefined

  const pathDetail = filePath ?? path
  if (pathDetail) {
    return { label: tc.name, detail: truncatePath(pathDetail, 80) }
  }
  const detail = command ?? url ?? pattern ?? description ?? undefined
  return {
    label: tc.name,
    detail: detail ? truncate(detail, 80) : undefined,
  }
}

/**
 * Walks the latest message in a compact group and returns a one-line summary
 * of the most recent meaningful activity (tool call name, last text snippet,
 * or "Thinking…").
 */
function summarizeGroup(
  group: { message: ChatMessage; globalIndex: number }[]
): { label: string; detail?: string; isThinking: boolean } {
  for (let g = group.length - 1; g >= 0; g--) {
    const message = group[g]?.message
    if (!message) continue
    const blocks = coalesceContentBlocks(message.content_blocks ?? [])
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (!block) continue
      if (block.type === 'tool_use') {
        const tc = message.tool_calls?.find(t => t.id === block.tool_call_id)
        if (tc) {
          const summary = summarizeToolCall(tc)
          return { ...summary, isThinking: false }
        }
        continue
      }
      if (block.type === 'thinking') {
        return { label: 'Thinking…', isThinking: true }
      }
      if (block.type === 'text' && block.text.trim()) {
        return { label: truncate(block.text.trim(), 120), isThinking: false }
      }
    }

    const lastTool = message.tool_calls?.[message.tool_calls.length - 1]
    if (lastTool) {
      const summary = summarizeToolCall(lastTool)
      return { ...summary, isThinking: false }
    }

    if (message.content?.trim()) {
      return {
        label: truncate(message.content.trim(), 120),
        isThinking: false,
      }
    }
  }
  return { label: 'Activity', isThinking: false }
}

function countSteps(group: { message: ChatMessage }[]): number {
  let total = 0
  for (const { message } of group) {
    total += message.tool_calls?.length ?? 0
  }
  return total
}

interface CompactActivityRowProps {
  group: { message: ChatMessage; globalIndex: number }[]
  total: number
  renderMessage: (
    item: { message: ChatMessage; globalIndex: number },
    extra: {
      hasFollowUpMessage: boolean
      durationMs: number | null
      hideCancelledIndicator?: boolean
    }
  ) => React.ReactNode
  hasFollowUpFor: (globalIndex: number) => boolean
  durationFor: (globalIndex: number, message: ChatMessage) => number | null
  /** When true, the recap section is rendered separately under the row, so
   * strip it from the latest assistant message inside the expanded body to
   * avoid duplicating the recap. */
  recapShownExternally?: boolean
}

function CompactActivityRow({
  group,
  total,
  renderMessage,
  hasFollowUpFor,
  durationFor,
  recapShownExternally,
}: CompactActivityRowProps) {
  const [isOpen, setIsOpen] = useState(false)
  const summary = useMemo(() => summarizeGroup(group), [group])
  const stepCount = useMemo(() => countSteps(group), [group])
  const messageCount = group.length
  const hasCancelledMessage = useMemo(
    () => group.some(item => item.message.cancelled),
    [group]
  )
  const groupDurationMs = useMemo(() => {
    for (let i = group.length - 1; i >= 0; i--) {
      const item = group[i]
      if (!item) continue
      const duration = durationFor(item.globalIndex, item.message)
      if (duration != null && duration > 0) return duration
    }
    return null
  }, [group, durationFor])

  const renderGroup = useMemo(() => {
    if (!recapShownExternally) return group
    let stripped = false
    return group
      .slice()
      .reverse()
      .map(item => {
        if (stripped || item.message.role !== 'assistant') return item
        stripped = true
        return { ...item, message: stripRecapFromMessage(item.message) }
      })
      .reverse()
  }, [group, recapShownExternally])

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className="min-w-0 pb-4"
    >
      <div
        className={
          'rounded-md border border-border/50 bg-muted/30 min-w-0' +
          (isOpen ? ' bg-muted/50' : '')
        }
      >
        <CollapsibleTrigger className={TOOL_CALL_ROW_CLASS}>
          {summary.isThinking ? (
            <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <Activity className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <span className="font-medium shrink-0 flex-none whitespace-nowrap">
            {summary.label}
          </span>
          {summary.detail && (
            <code className={TOOL_CALL_DETAIL_PILL_CLASS}>
              {summary.detail}
            </code>
          )}
          <span className="ml-auto flex items-center gap-2 shrink-0">
            <span className="hidden sm:inline text-muted-foreground/70 tabular-nums">
              {stepCount > 0
                ? `${stepCount} step${stepCount === 1 ? '' : 's'}`
                : `${messageCount} msg${messageCount === 1 ? '' : 's'}`}
            </span>
            <ChevronRight
              className={
                'h-3.5 w-3.5 transition-transform duration-200' +
                (isOpen ? ' rotate-90' : '')
              }
            />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/50 p-3 space-y-4">
            {renderGroup.map(item => (
              <div key={item.message.id}>
                {renderMessage(item, {
                  hasFollowUpMessage: hasFollowUpFor(item.globalIndex),
                  durationMs: durationFor(item.globalIndex, item.message),
                  hideCancelledIndicator: hasCancelledMessage,
                })}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
      {(groupDurationMs != null || hasCancelledMessage) && (
        <div className="mt-1 flex min-h-4 items-center gap-2 text-xs leading-4 text-muted-foreground/40">
          {groupDurationMs != null && (
            <span className="tabular-nums font-mono">
              {formatDuration(groupDurationMs)}
            </span>
          )}
          {hasCancelledMessage && (
            <span className="italic text-muted-foreground/50">(cancelled)</span>
          )}
        </div>
      )}
      <span aria-hidden className="sr-only">
        Total: {total}
      </span>
    </Collapsible>
  )
}

interface CompactQuestionMessageProps {
  message: ChatMessage
  globalIndex: number
  totalMessages: number
  hasFollowUpMessage: boolean
  durationMs: number | null
  sessionId: string
  onQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  onQuestionSkip: (toolCallId: string) => void
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  areQuestionsSkipped: (sessionId: string) => boolean
  renderMessage: (
    item: { message: ChatMessage; globalIndex: number },
    extra: {
      hasFollowUpMessage: boolean
      durationMs: number | null
      hideCancelledIndicator?: boolean
    }
  ) => React.ReactNode
  hasFollowUpFor: (globalIndex: number) => boolean
  durationFor: (globalIndex: number, message: ChatMessage) => number | null
}

/**
 * Renders an assistant message that asks the user a question:
 *  - The preceding tool calls / text are folded into a {@link CompactActivityRow}
 *    so only a single ticker line is visible by default.
 *  - The {@link AskUserQuestion}(s) themselves render full so the user can
 *    answer or skip.
 */
function CompactQuestionMessage({
  message,
  globalIndex,
  totalMessages: _totalMessages,
  hasFollowUpMessage,
  durationMs,
  sessionId,
  onQuestionAnswer,
  onQuestionSkip,
  isQuestionAnswered,
  getSubmittedAnswers,
  areQuestionsSkipped,
  renderMessage,
  hasFollowUpFor,
  durationFor,
}: CompactQuestionMessageProps) {
  const stripped = useMemo(() => stripQuestionsFromMessage(message), [message])

  const questionItems = useMemo(() => {
    const blocks = message.content_blocks ?? []
    const timeline = buildTimeline(blocks, message.tool_calls ?? [])
    return timeline.flatMap(item =>
      item.type === 'askUserQuestion' ? [item] : []
    )
  }, [message])

  const hasNonQuestionContent = useMemo(() => {
    if (stripped.tool_calls && stripped.tool_calls.length > 0) return true
    if (
      stripped.content_blocks &&
      stripped.content_blocks.some(
        b => b.type !== 'text' || (b.type === 'text' && b.text.trim() !== '')
      )
    ) {
      return true
    }
    return Boolean(stripped.content && stripped.content.trim() !== '')
  }, [stripped])

  return (
    <>
      {hasNonQuestionContent && (
        <CompactActivityRow
          group={[{ message: stripped, globalIndex }]}
          total={1}
          renderMessage={renderMessage}
          hasFollowUpFor={hasFollowUpFor}
          durationFor={durationFor}
        />
      )}
      {questionItems.map(item => {
        const isAnswered =
          hasFollowUpMessage ||
          isQuestionAnswered(sessionId, item.tool.id) ||
          hasQuestionAnswerOutput(item.tool.output)
        const normalizedQuestions = normalizeQuestionMultipleField(
          (getAskUserQuestions(item.tool.input) ?? []) as (Question & {
            multiple?: boolean
          })[]
        )
        return (
          <AskUserQuestion
            key={item.key}
            toolCallId={item.tool.id}
            questions={normalizedQuestions}
            introText={item.introText}
            hasFollowUpMessage={
              hasFollowUpMessage || hasQuestionAnswerOutput(item.tool.output)
            }
            isSkipped={areQuestionsSkipped(sessionId)}
            onSubmit={(toolCallId, answers) =>
              onQuestionAnswer(toolCallId, answers, normalizedQuestions)
            }
            onSkip={onQuestionSkip}
            readOnly={isAnswered}
            submittedAnswers={
              isAnswered
                ? getSubmittedAnswers(sessionId, item.tool.id)
                : undefined
            }
            toolOutput={item.tool.output ?? undefined}
          />
        )
      })}
      {durationMs != null && durationMs > 0 && (
        <span className="mt-1 block min-h-4 text-xs leading-4 text-muted-foreground/40 tabular-nums font-mono">
          {formatDuration(durationMs)}
        </span>
      )}
    </>
  )
}

/**
 * Compact replacement for {@link import('./VirtualizedMessageList').VirtualizedMessageList}
 * used when the `compact_chat_view_enabled` preference is on.
 *
 * Behaviour:
 *  - User messages render in full.
 *  - Assistant messages with plan tool calls render in full so PlanDisplay /
 *    ExitPlanModeButton remain interactive.
 *  - Assistant messages containing an AskUserQuestion fold their preceding
 *    tool calls into a single ticker line and render the question full.
 *  - The last assistant message (final conclusion) renders in full.
 *  - Other intermediate assistant messages collapse into a single
 *    {@link CompactActivityRow} that shows the latest tool / text and expands
 *    on click to reveal the buffered messages.
 */
export const CompactMessageList = memo(
  forwardRef<VirtualizedMessageListHandle, CompactMessageListProps>(
    function CompactMessageList(
      {
        messages,
        scrollContainerRef,
        totalMessages,
        lastPlanMessageIndex,
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
        shouldScrollToBottom,
        onScrollToBottomHandled,
        completedDurationMs,
        hasOlderOnDisk = false,
        isLoadingOlder = false,
        onLoadOlderRuns,
        loadedRunStartIndex = 0,
        hiddenPromptCount = 0,
        onShowHiddenPrompts,
      },
      ref
    ) {
      const messageRefs = useRef(new Map<number, HTMLDivElement>())
      const pendingPrependAnchorRef = useRef<PrependScrollAnchor | null>(null)
      const pendingPrependMessagesLengthRef = useRef<number | null>(null)

      // Stable accessor for the full message list. Kept in a ref so the
      // identity handed to memoized rows never changes — "subsequent edits"
      // stays lazy without busting per-row memoization.
      const messagesRef = useRef(messages)
      useEffect(() => {
        messagesRef.current = messages
      }, [messages])
      const getMessages = useCallback(() => messagesRef.current, [])

      const lastIndex = messages.length - 1
      const hasHiddenPrompts = hiddenPromptCount > 0 && !!onShowHiddenPrompts

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

      // Pre-compute provider switches between consecutive user prompts
      const providerChangeMap = useMemo(() => {
        const map = new Map<
          number,
          ReturnType<typeof getProviderChangeBeforeMessage>
        >()
        for (let i = 0; i < messages.length; i++) {
          const change = getProviderChangeBeforeMessage(messages, i)
          if (change) map.set(i, change)
        }
        return map
      }, [messages])

      const hasFollowUpFor = useCallback(
        (globalIndex: number) => hasFollowUpMap.get(globalIndex) ?? false,
        [hasFollowUpMap]
      )

      const latestRunHasPlan = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (!m) continue
          if (m.role === 'user') return false
          if (m.tool_calls?.some(isPlanToolCall)) return true
        }
        return false
      }, [messages])

      const durationFor = useCallback(
        (globalIndex: number, message: ChatMessage): number | null => {
          if (message !== messages[globalIndex]) return null
          return getAssistantDurationMs(
            messages,
            globalIndex,
            completedDurationMs
          )
        },
        [messages, completedDurationMs]
      )

      // Group messages into render items. Anything that should always render
      // full flushes the in-flight compact buffer.
      const renderItems = useMemo<RenderItem[]>(() => {
        const items: RenderItem[] = []
        let buffer: { message: ChatMessage; globalIndex: number }[] = []

        const flush = () => {
          if (buffer.length === 0) return
          const first = buffer[0]
          const last = buffer[buffer.length - 1]
          if (!first || !last) {
            buffer = []
            return
          }
          const compactKey =
            buffer.length === 1
              ? `compact-${first.message.id}`
              : `compact-${first.message.id}-${last.message.id}`
          items.push({
            kind: 'compact',
            messages: buffer,
            key: compactKey,
            latestText: findLatestAssistantText(buffer),
          })
          buffer = []
        }

        // Buffer an assistant message. Messages containing mid-turn steered
        // user prompts are split at each steer so the visible order matches
        // chronology: activity → steered bubble → activity after the steer.
        const pushBuffered = (message: ChatMessage, globalIndex: number) => {
          const segments = splitMessageAtSteeredInputs(message)
          if (!segments) {
            buffer.push({ message, globalIndex })
            return
          }
          for (const segment of segments) {
            if (segment.kind === 'steered') {
              flush()
              // Merge with a preceding steered group (e.g. across messages)
              const last = items[items.length - 1]
              if (last && last.kind === 'steered') {
                last.texts.push(...segment.texts)
              } else {
                items.push({
                  kind: 'steered',
                  texts: segment.texts,
                  key: segment.key,
                  messageId: message.id,
                  globalIndex,
                })
              }
            } else {
              buffer.push({ message: segment.message, globalIndex })
            }
          }
        }

        messages.forEach((message, globalIndex) => {
          if (message.role === 'user') {
            flush()
            items.push({ kind: 'message', message, globalIndex })
            return
          }

          if (messageContainsPlan(message)) {
            const isResolvedPlan =
              Boolean(message.plan_approved) &&
              (hasFollowUpMap.get(globalIndex) ?? false)
            if (!isResolvedPlan) {
              flush()
              items.push({ kind: 'message', message, globalIndex })
              return
            }
            pushBuffered(message, globalIndex)
            return
          }

          if (messageContainsQuestion(message)) {
            flush()
            items.push({ kind: 'question', message, globalIndex })
            return
          }

          pushBuffered(message, globalIndex)
        })

        flush()
        return items
      }, [messages, lastIndex, hasFollowUpMap])

      const renderMessageItem = useCallback(
        (
          item: { message: ChatMessage; globalIndex: number },
          extra: {
            hasFollowUpMessage: boolean
            durationMs: number | null
            hideCancelledIndicator?: boolean
          }
        ) => (
          <MessageItem
            message={item.message}
            getMessages={getMessages}
            messageIndex={item.globalIndex}
            totalMessages={totalMessages}
            lastPlanMessageIndex={lastPlanMessageIndex}
            hasFollowUpMessage={extra.hasFollowUpMessage}
            sessionId={sessionId}
            worktreePath={worktreePath}
            worktreeId={worktreeId}
            approveShortcut={approveShortcut}
            approveShortcutYolo={approveShortcutYolo}
            approveShortcutClearContext={approveShortcutClearContext}
            approveShortcutClearContextBuild={approveShortcutClearContextBuild}
            approveButtonRef={
              item.globalIndex === lastPlanMessageIndex
                ? approveButtonRef
                : undefined
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
            onFixFinding={onFixFinding}
            onFixAllFindings={onFixAllFindings}
            isQuestionAnswered={isQuestionAnswered}
            getSubmittedAnswers={getSubmittedAnswers}
            areQuestionsSkipped={areQuestionsSkipped}
            isFindingFixed={isFindingFixed}
            onCopyToInput={onCopyToInput}
            hideApproveButtons={hideApproveButtons}
            hideCancelledIndicator={extra.hideCancelledIndicator}
            durationMs={extra.durationMs}
          />
        ),
        [
          messages,
          totalMessages,
          lastPlanMessageIndex,
          sessionId,
          worktreePath,
          worktreeId,
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
        ]
      )

      const loadOlder = useCallback(() => {
        const container = scrollContainerRef.current
        if (
          !container ||
          !hasOlderOnDisk ||
          isLoadingOlder ||
          !onLoadOlderRuns ||
          pendingPrependMessagesLengthRef.current !== null
        ) {
          return
        }
        pendingPrependAnchorRef.current = capturePrependScrollAnchor(container)
        pendingPrependMessagesLengthRef.current = messages.length
        onLoadOlderRuns()
      }, [
        scrollContainerRef,
        hasOlderOnDisk,
        isLoadingOlder,
        onLoadOlderRuns,
        messages.length,
      ])

      // Restore scroll position after older messages prepend.
      useLayoutEffect(() => {
        const container = scrollContainerRef.current
        const anchor = pendingPrependAnchorRef.current
        const prevLen = pendingPrependMessagesLengthRef.current
        if (!container || prevLen === null) return
        if (isLoadingOlder) return

        pendingPrependAnchorRef.current = null
        pendingPrependMessagesLengthRef.current = null

        if (messages.length === prevLen) return

        restorePrependScrollAnchor(container, anchor)
      }, [scrollContainerRef, isLoadingOlder, messages.length])

      // Scroll-to-top auto-load.
      useEffect(() => {
        const container = scrollContainerRef.current
        if (!container || !hasOlderOnDisk || hasHiddenPrompts) return
        const handleScroll = () => {
          if (container.scrollTop < SCROLL_THRESHOLD) loadOlder()
        }
        container.addEventListener('scroll', handleScroll, { passive: true })
        return () => container.removeEventListener('scroll', handleScroll)
      }, [scrollContainerRef, hasOlderOnDisk, hasHiddenPrompts, loadOlder])

      // Scroll-to-bottom on new message arrival.
      const prevMessageCountRef = useRef(messages.length)
      useEffect(() => {
        if (
          shouldScrollToBottom &&
          pendingPrependMessagesLengthRef.current === null &&
          messages.length > prevMessageCountRef.current
        ) {
          const lastEl = messageRefs.current.get(lastIndex)
          if (lastEl) {
            lastEl.scrollIntoView({ behavior: 'instant', block: 'end' })
            onScrollToBottomHandled?.()
          }
        }
        prevMessageCountRef.current = messages.length
      }, [
        messages.length,
        lastIndex,
        shouldScrollToBottom,
        onScrollToBottomHandled,
      ])

      useImperativeHandle(ref, () => ({
        scrollToIndex: (
          index: number,
          options?: { align?: 'start' | 'center' | 'end' }
        ) => {
          const el = messageRefs.current.get(index)
          if (el) {
            el.scrollIntoView({
              behavior: 'smooth',
              block: options?.align ?? 'start',
            })
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
        getVisibleRange: () => ({ start: 0, end: lastIndex }),
      }))

      if (messages.length === 0) return null

      return (
        <div className="flex flex-col w-full">
          {(hasHiddenPrompts || hasOlderOnDisk) && (
            <button
              type="button"
              onClick={hasHiddenPrompts ? onShowHiddenPrompts : loadOlder}
              disabled={!hasHiddenPrompts && isLoadingOlder}
              className="w-full text-center text-muted-foreground text-xs py-2 opacity-60 hover:opacity-100 transition-opacity cursor-pointer disabled:cursor-wait"
            >
              {hasHiddenPrompts ? (
                `↑ Load old prompts (${hiddenPromptCount})`
              ) : isLoadingOlder ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading old prompts…
                </span>
              ) : (
                `↑ Load old prompts (${loadedRunStartIndex} older runs on disk)`
              )}
            </button>
          )}

          {renderItems.map(item => {
            if (item.kind === 'message') {
              const hasFollowUpMessage =
                item.message.role === 'assistant' &&
                hasFollowUpFor(item.globalIndex)
              const providerChange =
                providerChangeMap.get(item.globalIndex) ?? null
              return (
                <div
                  key={item.message.id}
                  data-message-anchor-id={item.message.id}
                  ref={el => {
                    if (el) messageRefs.current.set(item.globalIndex, el)
                    else messageRefs.current.delete(item.globalIndex)
                  }}
                  className={
                    item.globalIndex === lastIndex && isSending ? '' : 'pb-4'
                  }
                >
                  {providerChange && (
                    <ProviderChangeSeparator change={providerChange} />
                  )}
                  {renderMessageItem(
                    { message: item.message, globalIndex: item.globalIndex },
                    {
                      hasFollowUpMessage,
                      durationMs: durationFor(item.globalIndex, item.message),
                    }
                  )}
                </div>
              )
            }

            if (item.kind === 'question') {
              const hasFollowUpMessage = hasFollowUpFor(item.globalIndex)
              return (
                <div
                  key={item.message.id}
                  data-message-anchor-id={item.message.id}
                  ref={el => {
                    if (el) messageRefs.current.set(item.globalIndex, el)
                    else messageRefs.current.delete(item.globalIndex)
                  }}
                  className="pb-4"
                >
                  <CompactQuestionMessage
                    message={item.message}
                    globalIndex={item.globalIndex}
                    totalMessages={totalMessages}
                    hasFollowUpMessage={hasFollowUpMessage}
                    durationMs={durationFor(item.globalIndex, item.message)}
                    sessionId={sessionId}
                    onQuestionAnswer={onQuestionAnswer}
                    onQuestionSkip={onQuestionSkip}
                    isQuestionAnswered={isQuestionAnswered}
                    getSubmittedAnswers={getSubmittedAnswers}
                    areQuestionsSkipped={areQuestionsSkipped}
                    renderMessage={renderMessageItem}
                    hasFollowUpFor={hasFollowUpFor}
                    durationFor={durationFor}
                  />
                </div>
              )
            }

            if (item.kind === 'steered') {
              return (
                <div key={item.key} className="pb-4">
                  <SteeredPromptGroup
                    texts={item.texts}
                    worktreePath={worktreePath}
                    onCopyText={
                      onCopyToInput
                        ? text =>
                            onCopyToInput({
                              id: `${item.messageId}-steered-copy`,
                              session_id:
                                messages[item.globalIndex]?.session_id ??
                                sessionId,
                              role: 'user',
                              content: text,
                              timestamp:
                                messages[item.globalIndex]?.timestamp ??
                                Date.now(),
                              content_blocks: [],
                              tool_calls: [],
                            })
                        : undefined
                    }
                  />
                </div>
              )
            }

            const singleMessage = item.messages[0]
            if (
              item.messages.length === 1 &&
              singleMessage &&
              isPureTextAssistantMessage(singleMessage.message)
            ) {
              const hasFollowUpMessage = hasFollowUpFor(
                singleMessage.globalIndex
              )
              return (
                <div
                  key={singleMessage.message.id}
                  ref={el => {
                    if (el)
                      messageRefs.current.set(singleMessage.globalIndex, el)
                    else messageRefs.current.delete(singleMessage.globalIndex)
                  }}
                  className={
                    singleMessage.globalIndex === lastIndex && isSending
                      ? ''
                      : 'pb-4'
                  }
                >
                  {renderMessageItem(singleMessage, {
                    hasFollowUpMessage,
                    durationMs: durationFor(
                      singleMessage.globalIndex,
                      singleMessage.message
                    ),
                  })}
                </div>
              )
            }

            const isLatestCompact =
              renderItems.length > 0 &&
              renderItems[renderItems.length - 1] === item
            const latestTextIsRecap =
              Boolean(item.latestText) &&
              RECAP_HEADING_RE.test(item.latestText ?? '')
            const hasCancelledMessage = item.messages.some(
              ({ message }) => message.cancelled
            )
            const showLatestText =
              isLatestCompact &&
              !hasCancelledMessage &&
              Boolean(item.latestText) &&
              !(latestTextIsRecap && latestRunHasPlan)
            const surfaceRecap = latestTextIsRecap && showLatestText
            const surfacedLatestToolCalls = showLatestText
              ? item.messages.flatMap(({ message }) => message.tool_calls ?? [])
              : []
            return (
              <div key={item.key}>
                <CompactActivityRow
                  group={item.messages}
                  total={totalMessages}
                  renderMessage={renderMessageItem}
                  hasFollowUpFor={hasFollowUpFor}
                  durationFor={durationFor}
                  recapShownExternally={surfaceRecap}
                />
                {showLatestText && (
                  <div className="pb-4">
                    <Markdown
                      streaming={false}
                      messageId={item.key}
                      sessionId={sessionId}
                    >
                      {item.latestText ?? ''}
                    </Markdown>
                    {surfacedLatestToolCalls.length > 0 && (
                      <EditedFilesDisplay
                        toolCalls={surfacedLatestToolCalls}
                        worktreePath={worktreePath}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )
    }
  )
)
