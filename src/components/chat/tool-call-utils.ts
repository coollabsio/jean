import type {
  ToolCall,
  ContentBlock,
  Todo,
  PlanToolInput,
  Question,
} from '@/types/chat'
import {
  isTodoWrite,
  isCollabToolCall,
  isPlanToolCall,
  isAskUserQuestion,
  getAskUserQuestions,
  normalizeQuestionMultipleField,
  normalizeCodexQuestions,
} from '@/types/chat'

function isTodoWriteLike(toolCall: ToolCall): boolean {
  return isTodoWrite(toolCall)
}

/** Check if a tool is a task/agent container (Claude CLI uses both names) */
function isAgentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent'
}

/**
 * Normalize todos for display - marks in_progress as completed when message is done
 * During streaming, keeps in_progress status to show active work
 * When message is complete, any remaining in_progress tasks become completed
 * When message was cancelled, incomplete tasks are marked as cancelled
 */
export function normalizeTodosForDisplay(
  todos: Todo[],
  isStreaming: boolean,
  wasCancelled = false
): Todo[] {
  if (isStreaming) return todos

  return todos.map(todo => {
    // If message was cancelled, mark non-completed tasks as cancelled
    if (wasCancelled && todo.status !== 'completed') {
      return { ...todo, status: 'cancelled' as const }
    }
    // Normal completion: convert in_progress to completed
    if (todo.status === 'in_progress') {
      return { ...todo, status: 'completed' as const }
    }
    return todo
  })
}

/**
 * Groups tool calls for rendering:
 * - Task tools become containers that include subsequent non-Task tools
 * - Non-Task tools that aren't preceded by a Task are shown standalone
 * - Special tools (AskUserQuestion, ExitPlanMode) are excluded from grouping
 * - Returns an array of { type: 'task', task, subTools } or { type: 'standalone', tool }
 */
export type GroupedToolCall =
  | { type: 'task'; taskTool: ToolCall; subTools: ToolCall[] }
  | { type: 'standalone'; tool: ToolCall }

/**
 * Check if a tool call is a special tool that should not render in the timeline.
 * AskUserQuestion and ExitPlanMode have dedicated inline render paths.
 * TodoWrite (incl. Grok todo_write) and CodexTodoList are shown via dedicated todo UI.
 */
function isSpecialTool(toolCall: ToolCall): boolean {
  return (
    toolCall.name === 'AskUserQuestion' ||
    toolCall.name === 'ExitPlanMode' ||
    toolCall.name === 'CodexPlan' ||
    toolCall.name === 'EnterPlanMode' ||
    isTodoWriteLike(toolCall) ||
    toolCall.name === 'CodexTodoList'
  )
}

/**
 * Groups tool calls for rendering:
 * - Task tools become containers that include subsequent non-Task tools
 * - Non-Task tools that aren't preceded by a Task are shown standalone
 * - Special tools (AskUserQuestion, ExitPlanMode) are excluded from grouping
 * - Returns an array of { type: 'task', task, subTools } or { type: 'standalone', tool }
 */
export function groupToolCalls(toolCalls: ToolCall[]): GroupedToolCall[] {
  const result: GroupedToolCall[] = []
  let currentTask: { taskTool: ToolCall; subTools: ToolCall[] } | null = null

  for (const tool of toolCalls) {
    // Skip special tools - they're handled separately
    if (isSpecialTool(tool) || isCollabToolCall(tool)) {
      continue
    }

    if (isAgentTool(tool.name)) {
      // Finish previous task if any
      if (currentTask) {
        result.push({ type: 'task', ...currentTask })
      }
      // Start new task
      currentTask = { taskTool: tool, subTools: [] }
    } else if (currentTask) {
      // Add to current task's sub-tools
      currentTask.subTools.push(tool)
    } else {
      // Standalone tool (no task context)
      result.push({ type: 'standalone', tool })
    }
  }

  // Don't forget the last task
  if (currentTask) {
    result.push({ type: 'task', ...currentTask })
  }

  return result
}

/**
 * Item that can be stacked in a group (thinking or tool)
 */
export type StackableItem =
  | { type: 'thinking'; thinking: string }
  | { type: 'tool'; tool: ToolCall }

/**
 * Timeline item for rendering content blocks with proper tool grouping
 */
export type TimelineItem =
  | { type: 'text'; text: string; key: string }
  | { type: 'thinking'; thinking: string; key: string }
  | { type: 'task'; taskTool: ToolCall; subTools: ToolCall[]; key: string }
  | { type: 'standalone'; tool: ToolCall; key: string }
  | { type: 'stackedGroup'; items: StackableItem[]; key: string }
  | { type: 'askUserQuestion'; tool: ToolCall; introText?: string; key: string }
  | { type: 'enterPlanMode'; tool: ToolCall; key: string }
  | { type: 'exitPlanMode'; tool: ToolCall; key: string }
  | { type: 'userInput'; texts: string[]; key: string }
  | { type: 'unknown'; rawType: string; rawData: unknown; key: string }

export interface ResolvedPlanContent {
  content: string | null
  source:
    | 'plan'
    | 'plan_preview'
    | 'message_text'
    | 'steps'
    | 'explanation'
    | null
}

export interface SplitTextAroundPlanResult {
  beforePlan: string | null
  plan: string | null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Merge consecutive stackable items (thinking + standalone tools) into stackedGroup
 * Only groups if there are 2+ consecutive stackable items
 */
function mergeConsecutiveStackables(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = []
  let stackableBuffer: { item: StackableItem; key: string }[] = []

  const flushBuffer = () => {
    if (stackableBuffer.length >= 2) {
      const firstKey = stackableBuffer[0]?.key ?? 'unknown'
      result.push({
        type: 'stackedGroup',
        items: stackableBuffer.map(b => b.item),
        key: `stacked-${firstKey}`,
      })
    } else if (stackableBuffer.length === 1) {
      const buffered = stackableBuffer[0]
      if (buffered) {
        if (buffered.item.type === 'tool') {
          result.push({
            type: 'standalone',
            tool: buffered.item.tool,
            key: buffered.key,
          })
        } else {
          result.push({
            type: 'thinking',
            thinking: buffered.item.thinking,
            key: buffered.key,
          })
        }
      }
    }
    stackableBuffer = []
  }

  for (const item of items) {
    if (item.type === 'standalone') {
      stackableBuffer.push({
        item: { type: 'tool', tool: item.tool },
        key: item.key,
      })
    } else if (item.type === 'thinking') {
      stackableBuffer.push({
        item: { type: 'thinking', thinking: item.thinking },
        key: item.key,
      })
    } else {
      flushBuffer()
      result.push(item)
    }
  }

  // Flush remaining buffer
  flushBuffer()

  return result
}

/**
 * Build a timeline from content blocks and tool calls
 * Preserves the order from content_blocks while grouping Tasks with their sub-tools
 *
 * @param contentBlocks - Ordered content blocks from the message
 * @param toolCalls - All tool calls from the message
 * @returns Timeline items in the correct order for rendering
 */
/**
 * Merge consecutive text blocks into one.
 *
 * Replay/snapshot paths may deliver text as many separate `ContentBlock::Text`
 * entries (one per streaming delta). Streaming in-memory state coalesces them
 * via `chat-store.addTextBlock`. Run both inputs through this helper so the
 * timeline sees an identical shape regardless of origin.
 */
export function coalesceContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of blocks) {
    const last = out[out.length - 1]
    if (block.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: last.text + block.text }
    } else {
      out.push(block)
    }
  }
  return out
}

export function buildTimeline(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[]
): TimelineItem[] {
  const normalizedBlocks = coalesceContentBlocks(contentBlocks)
  const result: TimelineItem[] = []

  // Build a map of tool calls by ID for quick lookup
  const toolCallMap = new Map<string, ToolCall>()
  for (const tc of toolCalls) {
    toolCallMap.set(tc.id, tc)
  }

  // Build a map of which tools are sub-tools of which Task
  // Key: sub-tool ID, Value: parent Task ID
  const subToolParent = new Map<string, string>()

  // First pass: Use parent_tool_use_id if available (works with parallel tasks)
  // This is the authoritative source from Claude CLI
  for (const tc of toolCalls) {
    if (tc.parent_tool_use_id && !isSpecialTool(tc)) {
      // Only set if parent is a Task tool (not just any tool)
      const parentTool = toolCallMap.get(tc.parent_tool_use_id)
      if (parentTool && isAgentTool(parentTool.name)) {
        subToolParent.set(tc.id, tc.parent_tool_use_id)
      }
    }
  }

  // Second pass: Fallback for old messages without parent_tool_use_id
  // Find Tasks and their sub-tools by processing content_blocks in order
  // This respects the actual output sequence - text blocks indicate Task completion
  let currentTaskId: string | null = null
  for (const block of normalizedBlocks) {
    if (
      (block.type === 'text' && block.text.trim()) ||
      block.type === 'user_input'
    ) {
      // Text (or an injected user message) breaks the Task context
      currentTaskId = null
    } else if (block.type === 'tool_use') {
      const tool = toolCallMap.get(block.tool_call_id)
      if (!tool || isSpecialTool(tool)) continue

      if (isAgentTool(tool.name)) {
        currentTaskId = tool.id
      } else if (currentTaskId && !subToolParent.has(tool.id)) {
        // Only set if not already set by parent_tool_use_id (backward compat)
        subToolParent.set(tool.id, currentTaskId)
      }
      // else: standalone tool (no current Task context)
    }
  }

  // Track which Tasks we've already rendered (to collect their sub-tools)
  const renderedTasks = new Set<string>()

  // Track which AskUserQuestion tools we've already processed (to avoid duplicates)
  const renderedAskUserQuestions = new Set<string>()

  // Track if we've seen an AskUserQuestion - text after it is suppressed
  // (Claude often duplicates questions in text form after calling the tool)
  let seenAskUserQuestion = false

  // Track the last text block index to capture intro text for AskUserQuestion
  let lastTextIndex: number | null = null

  // Process content blocks in order
  for (let i = 0; i < normalizedBlocks.length; i++) {
    const block = normalizedBlocks[i]
    if (!block) continue

    if (block.type === 'thinking') {
      // Thinking content block (extended thinking)
      if (block.thinking.trim()) {
        result.push({
          type: 'thinking',
          thinking: block.thinking,
          key: `thinking-${i}`,
        })
      }
    } else if (block.type === 'text') {
      // Skip text that comes after AskUserQuestion (usually duplicate content)
      if (seenAskUserQuestion) continue
      if (block.text.trim()) {
        result.push({ type: 'text', text: block.text, key: `text-${i}` })
        lastTextIndex = result.length - 1
      }
    } else if (block.type === 'user_input') {
      // User text injected mid-turn (Codex turn/steer) — always rendered.
      // Consecutive steered prompts merge into one connected group.
      if (block.text.trim()) {
        const last = result[result.length - 1]
        if (last && last.type === 'userInput') {
          last.texts.push(block.text)
        } else {
          result.push({
            type: 'userInput',
            texts: [block.text],
            key: `input-${i}`,
          })
        }
      }
    } else if (block.type === 'tool_use') {
      // tool_use block
      const toolCall = toolCallMap.get(block.tool_call_id)
      if (!toolCall) continue

      // Handle special tools
      if (isAskUserQuestion(toolCall)) {
        // Skip if we've already processed this AskUserQuestion
        if (renderedAskUserQuestions.has(toolCall.id)) continue
        renderedAskUserQuestions.add(toolCall.id)

        // Capture intro text (the text block immediately before this tool)
        // and remove it from result so it's shown with the questions
        let introText: string | undefined
        if (lastTextIndex !== null) {
          const lastTextItem = result[lastTextIndex]
          if (lastTextItem && lastTextItem.type === 'text') {
            introText = lastTextItem.text
            result.splice(lastTextIndex, 1)
            lastTextIndex = null
          }
        }

        const rawQuestions = getAskUserQuestions(toolCall.input) ?? []
        const questionToolCall = {
          ...toolCall,
          input: {
            questions:
              toolCall.name === 'request_user_input'
                ? normalizeCodexQuestions(rawQuestions)
                : normalizeQuestionMultipleField(
                    rawQuestions as (Question & { multiple?: boolean })[]
                  ),
          },
        }

        // Render inline in natural position (not at end)
        result.push({
          type: 'askUserQuestion',
          tool: questionToolCall,
          introText,
          key: `ask-${toolCall.id}`,
        })
        // Mark that we've seen AskUserQuestion - suppress text that follows
        seenAskUserQuestion = true
        continue
      }
      if (isPlanToolCall(toolCall)) {
        result.push({
          type: 'exitPlanMode',
          tool: toolCall,
          key: `exit-${toolCall.id}`,
        })
        continue
      }
      if (toolCall.name === 'EnterPlanMode') {
        result.push({
          type: 'enterPlanMode',
          tool: toolCall,
          key: `enter-plan-${toolCall.id}`,
        })
        continue
      }
      if (isTodoWrite(toolCall)) {
        // TodoWrite is handled separately (shown above textarea)
        continue
      }
      if (toolCall.name === 'CodexTodoList') {
        // Codex todo list is handled separately (shown above textarea)
        continue
      }
      if (isCollabToolCall(toolCall)) {
        // Collab tools shown in AgentWidget panel, not timeline
        continue
      }

      // Skip if this is a sub-tool (it will be rendered with its parent Task)
      if (subToolParent.has(toolCall.id)) {
        continue
      }

      // Handle Task tools - collect their sub-tools
      if (isAgentTool(toolCall.name)) {
        if (renderedTasks.has(toolCall.id)) continue
        renderedTasks.add(toolCall.id)

        // Find all sub-tools for this task
        const subTools: ToolCall[] = []
        for (const [subId, parentId] of subToolParent.entries()) {
          if (parentId === toolCall.id) {
            const subTool = toolCallMap.get(subId)
            if (subTool) subTools.push(subTool)
          }
        }

        result.push({
          type: 'task',
          taskTool: toolCall,
          subTools,
          key: `task-${toolCall.id}`,
        })
      } else {
        // Standalone tool (not a sub-tool, not a Task)
        result.push({
          type: 'standalone',
          tool: toolCall,
          key: `tool-${toolCall.id}`,
        })
      }
    } else {
      // Unknown content block type — render a visible indicator
      result.push({
        type: 'unknown',
        rawType:
          ((block as Record<string, unknown>).type as string) ?? 'unknown',
        rawData: block,
        key: `unknown-${i}`,
      })
    }
  }

  // Merge consecutive stackable items (thinking + standalone tools) into groups
  return mergeConsecutiveStackables(result)
}

/**
 * Find the plan content from ExitPlanMode tool calls
 * This is the primary source for plan content (inline in tool input)
 *
 * @param toolCalls - All tool calls from the message
 * @returns The plan content if found, null otherwise
 */
export function findPlanContent(toolCalls: ToolCall[]): string | null {
  return resolvePlanContent({ toolCalls }).content
}

/** Detect legacy formatted checkbox steps in the plan field */
function looksLikeFormattedSteps(content: string): boolean {
  const firstLine = content.trim().split('\n')[0] ?? ''
  return /^- \[[ x-]\] /.test(firstLine)
}

function normalizePlanText(content: string): string {
  return content.trim().replace(/\r\n/g, '\n')
}

function getPlanField(input: PlanToolInput | undefined): string | null {
  return isNonEmptyString(input?.plan) ? input.plan : null
}

function getPlanPreviewField(input: PlanToolInput | undefined): string | null {
  return isNonEmptyString(input?.plan_preview) ? input.plan_preview : null
}

/** Status-only explanations are not handoff-quality plan bodies. */
function isStatusOnlyPlanExplanation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, '')
  if (!normalized) return true
  if (normalized.length > 80) return false
  return (
    /plan (created|ready|complete|completed|updated)/.test(normalized) ||
    /ready for approval/.test(normalized) ||
    /awaiting approval/.test(normalized)
  )
}

/**
 * Prefer the richest Codex/ExitPlanMode tool input when multiple plan tools
 * exist (e.g. split turn-id vs item-id after history reload).
 */
function getPlanToolInput(toolCalls: ToolCall[]): PlanToolInput | undefined {
  const planTools = toolCalls.filter(isPlanToolCall)
  if (planTools.length === 0) return undefined
  if (planTools.length === 1) {
    return planTools[0]?.input as PlanToolInput | undefined
  }

  let best: PlanToolInput | undefined
  let bestScore = -1
  for (const tool of planTools) {
    const input = tool.input as PlanToolInput
    const plan = getPlanField(input)
    const preview = getPlanPreviewField(input)
    const steps =
      input?.steps?.filter(step => isNonEmptyString(step.step)).length ?? 0
    const explanation = isNonEmptyString(input?.explanation)
      ? input.explanation.trim()
      : ''
    let score = 0
    if (plan && !looksLikeFormattedSteps(plan)) {
      score += 1000 + plan.trim().length
    }
    if (preview) score += 500 + preview.trim().length
    if (steps > 0) score += 100 + steps * 10
    if (explanation && !isStatusOnlyPlanExplanation(explanation)) {
      score += 50 + explanation.length
    } else if (explanation) {
      score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = input
    }
  }
  return best
}

/**
 * Merge plan fields from all plan tools so a thin explanation tool and a
 * rich plan-body tool still produce one complete handoff document.
 */
function getMergedPlanToolInput(
  toolCalls: ToolCall[]
): PlanToolInput | undefined {
  const planTools = toolCalls.filter(isPlanToolCall)
  if (planTools.length === 0) return undefined
  if (planTools.length === 1) {
    return planTools[0]?.input as PlanToolInput | undefined
  }

  const merged: PlanToolInput = { source: 'codex' }
  let bestPlan: string | null = null
  let bestPreview: string | null = null
  let bestSteps: PlanToolInput['steps']
  let bestExplanation: string | null = null

  for (const tool of planTools) {
    const input = tool.input as PlanToolInput
    const plan = getPlanField(input)
    if (
      plan &&
      !looksLikeFormattedSteps(plan) &&
      (!bestPlan || plan.trim().length > bestPlan.trim().length)
    ) {
      bestPlan = plan
    }
    const preview = getPlanPreviewField(input)
    if (
      preview &&
      (!bestPreview || preview.trim().length > bestPreview.trim().length)
    ) {
      bestPreview = preview
    }
    const steps = input?.steps?.filter(step => isNonEmptyString(step.step))
    if (steps && steps.length > (bestSteps?.length ?? 0)) {
      bestSteps = steps
    }
    if (isNonEmptyString(input?.explanation)) {
      const explanation = input.explanation.trim()
      if (
        !isStatusOnlyPlanExplanation(explanation) &&
        (!bestExplanation || explanation.length > bestExplanation.length)
      ) {
        bestExplanation = explanation
      } else if (!bestExplanation) {
        bestExplanation = explanation
      }
    }
  }

  if (bestPlan) merged.plan = bestPlan
  if (bestPreview) merged.plan_preview = bestPreview
  if (bestSteps) merged.steps = bestSteps
  if (bestExplanation) merged.explanation = bestExplanation
  return merged
}

function formatPlanSteps(input: PlanToolInput | undefined): string | null {
  const steps = input?.steps?.filter(step => isNonEmptyString(step.step)) ?? []
  if (steps.length === 0) return null

  const formattedSteps = steps.map(step => {
    if (step.status === 'completed') return `- [x] ${step.step}`
    if (step.status === 'in_progress') {
      return `- [ ] **In progress:** ${step.step}`
    }
    return `- [ ] ${step.step}`
  })

  const explanation = isNonEmptyString(input?.explanation)
    ? input.explanation.trim()
    : null
  // Don't promote status-only explanations as plan intro text
  const intro =
    explanation && !isStatusOnlyPlanExplanation(explanation)
      ? explanation
      : null
  return [intro, formattedSteps.join('\n')].filter(Boolean).join('\n\n')
}

export function splitTextAroundPlan(text: string): SplitTextAroundPlanResult {
  const normalized = normalizePlanText(text)
  if (!normalized) {
    return { beforePlan: null, plan: null }
  }

  // Codex often emits intro prose followed by the actual plan as regular
  // assistant text. Keep only the trailing `Plan:` section so PlanDisplay
  // shows the actionable plan body without duplicating the intro prose.
  const planHeadingMatch = normalized.match(/(^|\n)(Plan:\s*[\s\S]*)$/)
  if (planHeadingMatch) {
    const fullMatch = planHeadingMatch[0] ?? ''
    const extracted = planHeadingMatch[2]?.trim() ?? null
    const beforePlan = normalized
      .slice(0, normalized.length - fullMatch.length)
      .trim()

    return {
      beforePlan: beforePlan || null,
      plan: extracted || null,
    }
  }

  const firstLine = normalized.split('\n')[0] ?? ''
  if (/^Plan:\s*/.test(firstLine)) {
    return { beforePlan: null, plan: normalized }
  }

  return { beforePlan: normalized, plan: null }
}

function extractPlanSectionFromText(text: string): string | null {
  return splitTextAroundPlan(text).plan
}

function extractPlanSectionFromCandidates(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const extracted = extractPlanSectionFromText(candidate)
    if (extracted) return extracted
  }

  return null
}

function collectPlanTextCandidates(params: {
  messageContent?: string | null
  contentBlocks?: ContentBlock[]
}): string[] {
  const candidates: string[] = []

  if (params.messageContent?.trim()) {
    candidates.push(params.messageContent)
  }

  if (params.contentBlocks?.length) {
    const textBlocks = params.contentBlocks.flatMap(block =>
      block.type === 'text' && block.text.trim() ? [block.text] : []
    )

    if (textBlocks.length > 1) {
      candidates.push(textBlocks.join(''))
    }

    for (const text of textBlocks) {
      candidates.push(text)
    }
  }

  return candidates
}

export function resolvePlanContent(params: {
  toolCalls: ToolCall[]
  messageContent?: string | null
  contentBlocks?: ContentBlock[]
}): ResolvedPlanContent {
  // Merge across split CodexPlan tools (turn-id vs item-id) so the richest
  // body/steps win instead of whichever tool was inserted first.
  const input =
    getMergedPlanToolInput(params.toolCalls) ??
    getPlanToolInput(params.toolCalls)
  const plan = getPlanField(input)
  const planPreview = getPlanPreviewField(input)

  if (plan && !looksLikeFormattedSteps(plan)) {
    return { content: plan, source: 'plan' }
  }

  if (planPreview) {
    return { content: planPreview, source: 'plan_preview' }
  }

  const extractedFromText = extractPlanSectionFromCandidates(
    collectPlanTextCandidates(params)
  )
  if (extractedFromText) {
    return { content: extractedFromText, source: 'message_text' }
  }

  // Prefer full assistant text over thin checklist/status when no structured
  // plan body was persisted — YOLO/new-worktree handoff needs the prose.
  const fullAssistantText = collectPlanTextCandidates(params)
    .map(text => text.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]
  const formattedSteps = formatPlanSteps(input)
  if (
    fullAssistantText &&
    fullAssistantText.length >= 120 &&
    (!formattedSteps || fullAssistantText.length > formattedSteps.length * 2)
  ) {
    return { content: fullAssistantText, source: 'message_text' }
  }

  if (formattedSteps) {
    return { content: formattedSteps, source: 'steps' }
  }

  if (
    isNonEmptyString(input?.explanation) &&
    !isStatusOnlyPlanExplanation(input.explanation)
  ) {
    return { content: input.explanation, source: 'explanation' }
  }

  // Last resort: status-only explanation (still better than empty for UI)
  if (isNonEmptyString(input?.explanation)) {
    return { content: input.explanation, source: 'explanation' }
  }

  if (fullAssistantText) {
    return { content: fullAssistantText, source: 'message_text' }
  }

  return { content: null, source: null }
}

export function isDuplicatePlanTextBlock(
  text: string,
  resolvedPlanContent: string | null
): boolean {
  if (!resolvedPlanContent) return false
  // Direct match: the text block IS the plan content (Cursor CLI — no "Plan:" prefix)
  if (normalizePlanText(text) === normalizePlanText(resolvedPlanContent))
    return true
  // "Plan:"-prefixed match: Codex emits intro prose + "Plan:\n..." section
  const extracted = extractPlanSectionFromText(text)
  if (!extracted) return false
  return normalizePlanText(extracted) === normalizePlanText(resolvedPlanContent)
}

export function getIntroTextBeforeDuplicatePlan(
  text: string,
  resolvedPlanContent: string | null
): string | null {
  if (!resolvedPlanContent) return null

  // If the whole assistant text is the rendered plan, there is no separate intro
  // to show. This happens when Codex final_answer is mirrored into CodexPlan.
  if (normalizePlanText(text) === normalizePlanText(resolvedPlanContent)) {
    return null
  }

  const split = splitTextAroundPlan(text)
  if (!split.plan) return null
  if (
    normalizePlanText(split.plan) !== normalizePlanText(resolvedPlanContent)
  ) {
    return null
  }

  return split.beforePlan
}

export function getPlanTextBlockIndicesToHide(
  contentBlocks: ContentBlock[] | undefined,
  resolvedPlanContent: string | null
): Set<number> {
  const hidden = new Set<number>()
  if (!contentBlocks?.length || !resolvedPlanContent) return hidden

  const textBlocks = contentBlocks.flatMap((block, index) =>
    block.type === 'text' && block.text.trim()
      ? [{ index, text: block.text }]
      : []
  )
  if (textBlocks.length === 0) return hidden

  const joinedText = textBlocks.map(block => block.text).join('')
  // Direct match: all text blocks together ARE the plan (Cursor CLI — no "Plan:" prefix)
  if (
    normalizePlanText(joinedText) === normalizePlanText(resolvedPlanContent)
  ) {
    return new Set(textBlocks.map(block => block.index))
  }
  const extracted = extractPlanSectionFromText(joinedText)
  if (!extracted) return hidden
  if (normalizePlanText(extracted) !== normalizePlanText(resolvedPlanContent)) {
    return hidden
  }

  const planStart = normalizePlanText(joinedText).indexOf(
    normalizePlanText(extracted)
  )
  if (planStart < 0) return hidden

  let offset = 0
  for (const block of textBlocks) {
    const normalizedBlock = normalizePlanText(block.text)
    const start = offset
    const end = start + normalizedBlock.length
    if (end > planStart) {
      hidden.add(block.index)
    }
    offset = end
  }

  return hidden
}

/**
 * Find the plan file path from tool calls
 * Looks for Write tool calls that target ~/.claude/plans/*.md files
 * (Fallback for old-style file-based plans)
 *
 * @param toolCalls - All tool calls from the message
 * @returns The plan file path if found, null otherwise
 */
export function findPlanFilePath(toolCalls: ToolCall[]): string | null {
  // Look for Write tool calls to ~/.claude/plans/*.md
  const planWrite = toolCalls.find(t => {
    if (t.name !== 'Write') return false
    const input = t.input as { file_path?: string } | undefined
    const filePath = input?.file_path
    return filePath?.includes('/.claude/plans/') && filePath.endsWith('.md')
  })

  if (!planWrite) return null

  const input = planWrite.input as { file_path: string }
  return input.file_path
}
