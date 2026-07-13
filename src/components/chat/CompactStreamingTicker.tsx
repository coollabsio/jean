import { memo, useMemo, useState } from 'react'
import { Loader2, Activity, Brain, ChevronRight } from 'lucide-react'
import type { ContentBlock, ToolCall } from '@/types/chat'
import { isPlanToolCall } from '@/types/chat'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  TOOL_CALL_ROW_CLASS,
  TOOL_CALL_DETAIL_PILL_CLASS,
} from './ToolCallInline'
import { EditedFilesDisplay } from './EditedFilesDisplay'
import { StreamingMessage } from './StreamingMessage'
import { SteeredPromptGroup } from './SteeredPromptGroup'
import {
  coalesceContentBlocks,
  isDuplicatePlanTextBlock,
  resolvePlanContent,
} from './tool-call-utils'
import type { ComponentProps } from 'react'

type StreamingMessageProps = ComponentProps<typeof StreamingMessage>

/**
 * Pulls a one-line label/detail out of the latest content block or tool call
 * for the compact streaming ticker.
 */
function summarizeLatest(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[],
  streamingContent: string
): { label: string; detail?: string } {
  // Prefer the most recent content block (preserves order of text + tools).
  const normalizedBlocks = coalesceContentBlocks(contentBlocks)
  for (let i = normalizedBlocks.length - 1; i >= 0; i--) {
    const block = normalizedBlocks[i]
    if (!block) continue
    if (block.type === 'tool_use') {
      const tc = toolCalls.find(t => t.id === block.tool_call_id)
      if (tc) return summarizeToolCall(tc)
      continue
    }
    if (block.type === 'thinking') {
      return { label: 'Thinking…' }
    }
    if (block.type === 'text' && block.text.trim()) {
      return { label: truncate(block.text.trim(), 120) }
    }
  }

  // No blocks yet — fall back to last tool call or raw streaming text.
  const lastTool = toolCalls[toolCalls.length - 1]
  if (lastTool) return summarizeToolCall(lastTool)
  if (streamingContent.trim()) {
    return { label: truncate(streamingContent.trim(), 120) }
  }
  return { label: 'Working…' }
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

  const detail =
    filePath ?? path ?? command ?? url ?? pattern ?? description ?? undefined
  return {
    label: tc.name,
    detail: detail ? truncate(detail, 80) : undefined,
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function isPlanToolBlock(block: ContentBlock, toolCalls: ToolCall[]): boolean {
  if (block.type !== 'tool_use') return false
  const tool = toolCalls.find(t => t.id === block.tool_call_id)
  return tool ? isPlanToolCall(tool) : false
}

function filterPlanToolBlocks(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[]
): ContentBlock[] {
  return contentBlocks.filter(block => isPlanToolBlock(block, toolCalls))
}

function filterActivityBlocks(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[],
  planContent: string | null
): ContentBlock[] {
  return contentBlocks.filter(block => {
    if (isPlanToolBlock(block, toolCalls)) return false
    // Steered user prompts render separately above the ticker
    if (block.type === 'user_input') return false
    if (
      block.type === 'text' &&
      planContent &&
      isDuplicatePlanTextBlock(block.text, planContent)
    ) {
      return false
    }
    return true
  })
}

type CompactStreamSegment =
  | { type: 'activity'; blocks: ContentBlock[]; toolCalls: ToolCall[] }
  | { type: 'steered'; texts: string[] }

function splitAtSteeredInputs(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[],
  appendWorkingSection: boolean
): CompactStreamSegment[] {
  const segments: CompactStreamSegment[] = []
  let activityBlocks: ContentBlock[] = []

  const flushActivity = () => {
    if (activityBlocks.length === 0) return
    const toolIds = new Set(
      activityBlocks.flatMap(block =>
        block.type === 'tool_use' ? [block.tool_call_id] : []
      )
    )
    segments.push({
      type: 'activity',
      blocks: activityBlocks,
      toolCalls: toolCalls.filter(tool => toolIds.has(tool.id)),
    })
    activityBlocks = []
  }

  for (const block of contentBlocks) {
    if (block.type !== 'user_input') {
      activityBlocks.push(block)
      continue
    }

    flushActivity()
    if (!block.text.trim()) continue

    const last = segments[segments.length - 1]
    if (last?.type === 'steered') {
      last.texts.push(block.text)
    } else {
      segments.push({ type: 'steered', texts: [block.text] })
    }
  }

  flushActivity()
  if (appendWorkingSection && segments.at(-1)?.type === 'steered') {
    segments.push({ type: 'activity', blocks: [], toolCalls: [] })
  }

  return segments
}

function hasVisibleActivity(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[],
  streamingContent: string
): boolean {
  return (
    contentBlocks.some(block => {
      if (block.type === 'text') return block.text.trim().length > 0
      if (block.type === 'thinking') return block.thinking.trim().length > 0
      return true
    }) ||
    toolCalls.length > 0 ||
    streamingContent.trim().length > 0
  )
}

/**
 * Compact replacement for {@link StreamingMessage} when the
 * `compact_chat_view_enabled` preference is on.
 *
 * Renders a single ticker line showing the latest content block or tool call,
 * with a click-to-expand affordance that swaps in the full
 * {@link StreamingMessage} so the user can watch the in-flight response in real
 * time. When the response includes a plan, keeps non-plan activity compact and
 * renders the plan separately so plan-mode tool batches do not expand into
 * multiple visible tool groups while streaming.
 */
export const CompactStreamingTicker = memo(function CompactStreamingTicker(
  props: StreamingMessageProps
) {
  const {
    contentBlocks,
    toolCalls,
    streamingContent,
    onCopySteeredText,
    worktreePath,
  } = props
  const [isOpen, setIsOpen] = useState(false)

  const {
    activityBlocks,
    activityToolCalls,
    planBlocks,
    planToolCalls,
    planStreamingContent,
    steeredTexts,
    orderedActivityBlocks,
  } = useMemo(() => {
    const plan = resolvePlanContent({
      toolCalls,
      messageContent: streamingContent,
      contentBlocks,
    }).content
    const plans = toolCalls.filter(isPlanToolCall)
    const ordered = contentBlocks.filter(block => {
      if (isPlanToolBlock(block, toolCalls)) return false
      if (
        block.type === 'text' &&
        plan &&
        isDuplicatePlanTextBlock(block.text, plan)
      ) {
        return false
      }
      return true
    })
    return {
      activityBlocks: filterActivityBlocks(ordered, toolCalls, plan),
      activityToolCalls: toolCalls.filter(tc => !isPlanToolCall(tc)),
      planBlocks: filterPlanToolBlocks(contentBlocks, toolCalls),
      planToolCalls: plans,
      planStreamingContent: plan ?? '',
      orderedActivityBlocks: ordered,
      // User prompts injected mid-turn (Codex turn/steer) — surfaced as
      // separate visible bubbles instead of buried in the collapsed ticker.
      steeredTexts: contentBlocks.flatMap(block =>
        block.type === 'user_input' && block.text.trim() ? [block.text] : []
      ),
    }
  }, [contentBlocks, toolCalls, streamingContent])

  const hasActivity = hasVisibleActivity(
    activityBlocks,
    activityToolCalls,
    planToolCalls.length > 0 ? '' : streamingContent
  )
  const hasPlan = planToolCalls.length > 0

  const steeredSegments = useMemo(
    () =>
      splitAtSteeredInputs(orderedActivityBlocks, activityToolCalls, !hasPlan),
    [orderedActivityBlocks, activityToolCalls, hasPlan]
  )

  if (steeredTexts.length > 0) {
    let lastActivityIndex = -1
    steeredSegments.forEach((segment, index) => {
      if (segment.type === 'activity') lastActivityIndex = index
    })
    return (
      <div className="space-y-3">
        {steeredSegments.map((segment, index) =>
          segment.type === 'steered' ? (
            <SteeredPromptGroup
              key={`steered-${index}`}
              texts={segment.texts}
              worktreePath={worktreePath}
              onCopyText={onCopySteeredText}
            />
          ) : (
            <CompactStreamingTicker
              key={`activity-${index}`}
              {...props}
              contentBlocks={segment.blocks}
              toolCalls={segment.toolCalls}
              streamingContent={
                index === lastActivityIndex && segment.blocks.length > 0
                  ? streamingContent
                  : ''
              }
            />
          )
        )}
        {hasPlan && (
          <StreamingMessage
            {...props}
            contentBlocks={planBlocks}
            toolCalls={planToolCalls}
            streamingContent={planStreamingContent}
          />
        )}
      </div>
    )
  }

  if (hasPlan && !hasActivity) {
    return (
      <div className="space-y-3">
        <SteeredPromptGroup
          texts={steeredTexts}
          worktreePath={worktreePath}
          onCopyText={onCopySteeredText}
        />
        <StreamingMessage
          {...props}
          contentBlocks={planBlocks}
          toolCalls={planToolCalls}
          streamingContent={planStreamingContent}
        />
      </div>
    )
  }

  const { label, detail } = summarizeLatest(
    activityBlocks,
    activityToolCalls,
    hasPlan ? '' : streamingContent
  )
  const stepCount = activityToolCalls.length

  return (
    <div className="space-y-3">
      <SteeredPromptGroup
        texts={steeredTexts}
        worktreePath={worktreePath}
        onCopyText={onCopySteeredText}
      />
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="min-w-0">
        <div
          className={
            'rounded-md border border-border/50 bg-muted/30 min-w-0' +
            (isOpen ? ' bg-muted/50' : '')
          }
        >
          <CollapsibleTrigger className={TOOL_CALL_ROW_CLASS}>
            {label === 'Thinking…' ? (
              <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
            ) : (
              <Activity className="h-3.5 w-3.5 shrink-0 opacity-70" />
            )}
            <span className="font-medium shrink-0 flex-none whitespace-nowrap">
              {label}
            </span>
            {detail && (
              <code className={TOOL_CALL_DETAIL_PILL_CLASS}>{detail}</code>
            )}
            <span className="ml-auto flex items-center gap-2 shrink-0">
              {stepCount > 0 && (
                <span className="text-muted-foreground/70 tabular-nums">
                  {stepCount} step{stepCount === 1 ? '' : 's'}
                </span>
              )}
              <Loader2 className="h-3 w-3 animate-spin opacity-50" />
              <ChevronRight
                className={
                  'h-3.5 w-3.5 transition-transform duration-200' +
                  (isOpen ? ' rotate-90' : '')
                }
              />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border/50 p-3">
              <StreamingMessage
                {...props}
                contentBlocks={activityBlocks}
                toolCalls={activityToolCalls}
                streamingContent={hasPlan ? '' : streamingContent}
              />
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
      <EditedFilesDisplay
        toolCalls={activityToolCalls}
        worktreePath={worktreePath}
      />
      {hasPlan && (
        <StreamingMessage
          {...props}
          contentBlocks={planBlocks}
          toolCalls={planToolCalls}
          streamingContent={planStreamingContent}
        />
      )}
    </div>
  )
})
