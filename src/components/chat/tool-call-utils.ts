import type { ToolCall, ContentBlock, Todo } from '@/types/chat'
import { isTodoWrite, isCollabToolCall } from '@/types/chat'

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
 * TodoWrite and CodexTodoList are shown via dedicated todo UI.
 */
function isSpecialTool(toolCall: ToolCall): boolean {
  return (
    toolCall.name === 'AskUserQuestion' ||
    toolCall.name === 'ExitPlanMode' ||
    toolCall.name === 'EnterPlanMode' ||
    toolCall.name === 'TodoWrite' ||
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
  | { type: 'unknown'; rawType: string; rawData: unknown; key: string }

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
export function buildTimeline(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[]
): TimelineItem[] {
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
  for (const block of contentBlocks) {
    if (block.type === 'text' && block.text.trim()) {
      // Text breaks the Task context - the agent has returned
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
  for (let i = 0; i < contentBlocks.length; i++) {
    const block = contentBlocks[i]
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
    } else if (block.type === 'tool_use') {
      // tool_use block
      const toolCall = toolCallMap.get(block.tool_call_id)
      if (!toolCall) continue

      // Handle special tools
      if (toolCall.name === 'AskUserQuestion') {
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

        // Render inline in natural position (not at end)
        result.push({
          type: 'askUserQuestion',
          tool: toolCall,
          introText,
          key: `ask-${toolCall.id}`,
        })
        // Mark that we've seen AskUserQuestion - suppress text that follows
        seenAskUserQuestion = true
        continue
      }
      if (toolCall.name === 'ExitPlanMode') {
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
  const exitPlanTool = toolCalls.find(tc => tc.name === 'ExitPlanMode')
  if (!exitPlanTool) return null
  const input = exitPlanTool.input as { plan?: string } | undefined
  return input?.plan ?? null
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
