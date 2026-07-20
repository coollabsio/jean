import { useCallback, useEffect, useState } from 'react'
import { usePreferences } from '@/services/preferences'
import { useChatStore } from '@/store/chat-store'
import { useVisibilityAwareTicker } from '@/hooks/useVisibilityAwareTicker'
import {
  FileText,
  Edit,
  PenLine,
  Terminal,
  Search,
  Folder,
  Globe,
  Bot,
  ChevronRight,
  ExternalLink,
  Layers,
  Brain,
  Loader2,
  Users,
  Send,
  Clock,
  XCircle,
  ListTodo,
  CheckCircle2,
  Circle,
  Wand2,
  Image as ImageIcon,
  FileCode,
  List,
  Code,
  Activity,
} from 'lucide-react'
import type { ToolCall } from '@/types/chat'
import type { StackableItem } from './tool-call-utils'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { getFilename } from '@/lib/path-utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { InlineFileDiff } from './InlineFileDiff'

function shouldRenderRawOutput(toolCall: ToolCall): boolean {
  return (
    Boolean(toolCall.output) &&
    toolCall.name !== 'FileChange' &&
    toolCall.name !== 'Monitor'
  )
}

// Single source of truth for tool call row layout. Bump min-h-9/px-2.5 here, all rows update.
// min-h ensures consistent baseline regardless of inline-content height (pill vs no-pill).
export const TOOL_CALL_ROW_CLASS =
  'flex min-h-9 w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 select-none min-w-0'

export const TOOL_CALL_SUB_ROW_CLASS =
  'flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/80 hover:bg-muted/30 select-none min-w-0'

// Detail pill — sits AFTER label, snug to content (no flex-1 stretch).
export const TOOL_CALL_DETAIL_PILL_CLASS =
  'min-w-0 max-w-[55%] sm:max-w-full truncate rounded px-1 text-[0.6875rem] font-sans leading-none'

interface ToolCallInlineProps {
  toolCall: ToolCall
  className?: string
  /** Callback when a file path is clicked (for Read/Edit/Write tools) */
  onFileClick?: (filePath: string) => void
  /** Whether the message is currently streaming */
  isStreaming?: boolean
  /** Whether this item is still in progress (shows spinner) */
  isIncomplete?: boolean
}

/**
 * Collapsible inline display for a single tool call (non-Task)
 * Used for standalone tools or as sub-items within a Task
 */
export function ToolCallInline({
  toolCall,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: ToolCallInlineProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useState(
    preferences?.expand_tool_calls_by_default ?? false
  )
  const { icon, label, detail, filePath, expandedContent } =
    getToolDisplay(toolCall)

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath && onFileClick) {
      onFileClick(filePath)
    }
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn('min-w-0', className)}
    >
      <div
        className={cn(
          'rounded-md border border-border/50 bg-muted/30 min-w-0',
          isOpen && 'bg-muted/50'
        )}
      >
        <CollapsibleTrigger className={TOOL_CALL_ROW_CLASS}>
          {icon}
          <span className="font-medium shrink-0 flex-none whitespace-nowrap">
            {label}
          </span>
          {detail && filePath && onFileClick ? (
            <code
              role="button"
              tabIndex={0}
              onClick={handleFileClick}
              onKeyDown={e =>
                e.key === 'Enter' &&
                handleFileClick(e as unknown as React.MouseEvent)
              }
              className={cn(
                TOOL_CALL_DETAIL_PILL_CLASS,
                'inline-flex items-center gap-1 hover:bg-primary/20 hover:text-primary transition-colors cursor-pointer'
              )}
            >
              <span className="truncate">{detail}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </code>
          ) : detail ? (
            <code className={TOOL_CALL_DETAIL_PILL_CLASS}>{detail}</code>
          ) : null}
          {isStreaming && isIncomplete ? (
            <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
          ) : (
            <ChevronRight
              className={cn(
                'ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/50 px-3 py-2">
            <div className="whitespace-pre-wrap text-xs text-muted-foreground">
              {expandedContent}
            </div>
            {shouldRenderRawOutput(toolCall) && (
              <>
                <div className="border-t border-border/30 my-2" />
                <div className="text-xs text-muted-foreground/60 mb-1">
                  Output:
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs font-mono text-foreground/80 bg-muted/50 rounded p-2">
                  {toolCall.output}
                </pre>
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface TaskCallInlineProps {
  taskToolCall: ToolCall
  subToolCalls: ToolCall[]
  /** All tool calls in the message, used to resolve nested Task sub-tools */
  allToolCalls?: ToolCall[]
  className?: string
  /** Callback when a file path is clicked (for Read/Edit/Write tools) */
  onFileClick?: (filePath: string) => void
  /** Whether the message is currently streaming */
  isStreaming?: boolean
  /** Whether this item is still in progress (shows spinner) */
  isIncomplete?: boolean
}

/**
 * Collapsible inline display for Task tool calls with nested sub-tools
 * Shows the Task as a container with all its sub-agent tool calls inside
 */
export function TaskCallInline({
  taskToolCall,
  subToolCalls,
  allToolCalls,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: TaskCallInlineProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useState(
    preferences?.expand_tool_calls_by_default ?? false
  )
  const input = taskToolCall.input as Record<string, unknown>
  const subagentType = input.subagent_type as string | undefined
  const description = input.description as string | undefined
  const prompt = input.prompt as string | undefined
  const report = taskToolCall.output?.trim() || undefined
  const toolLabel = taskToolCall.name === 'Agent' ? 'Agent' : 'Task'

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn('min-w-0', className)}
    >
      <div
        className={cn(
          'rounded-md border border-border/50 bg-muted/30 min-w-0',
          isOpen && 'bg-muted/50'
        )}
      >
        <CollapsibleTrigger className={TOOL_CALL_ROW_CLASS}>
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium shrink-0 whitespace-nowrap">
            {subagentType ? `${toolLabel} (${subagentType})` : toolLabel}
          </span>
          {description && (
            <code className={TOOL_CALL_DETAIL_PILL_CLASS}>{description}</code>
          )}
          {/* Show sub-tool count badge */}
          {subToolCalls.length > 0 && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground/60">
              {subToolCalls.length} tool{subToolCalls.length === 1 ? '' : 's'}
            </span>
          )}
          {isStreaming && isIncomplete ? (
            <Loader2
              className={cn(
                subToolCalls.length === 0 && 'ml-auto',
                'h-3 w-3 shrink-0 animate-spin text-muted-foreground/50'
              )}
            />
          ) : (
            <ChevronRight
              className={cn(
                subToolCalls.length === 0 && 'ml-auto',
                'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/50 px-3 py-2 space-y-2">
            {/* Show prompt/instructions */}
            {prompt && (
              <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
                {prompt}
              </div>
            )}
            {/* Show sub-tools as compact list */}
            {subToolCalls.length > 0 ? (
              <div className="space-y-1">
                {subToolCalls.map(subTool =>
                  (subTool.name === 'Task' || subTool.name === 'Agent') &&
                  allToolCalls ? (
                    <TaskCallInline
                      key={subTool.id}
                      taskToolCall={subTool}
                      subToolCalls={allToolCalls.filter(
                        t => t.parent_tool_use_id === subTool.id
                      )}
                      allToolCalls={allToolCalls}
                      onFileClick={onFileClick}
                      isStreaming={isStreaming}
                    />
                  ) : (
                    <SubToolItem
                      key={subTool.id}
                      toolCall={subTool}
                      onFileClick={onFileClick}
                    />
                  )
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60 italic">
                No sub-tools recorded
              </p>
            )}
            {/* Subagent final report returned to the parent agent */}
            {report && (
              <div className="space-y-1">
                <div className="border-t border-border/30" />
                <div className="text-xs text-muted-foreground/60">Report:</div>
                <div className="max-h-64 overflow-y-auto text-xs text-foreground/80 bg-muted/50 rounded p-2">
                  <Markdown variant="tool-call">{report}</Markdown>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface StackedGroupProps {
  items: StackableItem[]
  className?: string
  onFileClick?: (filePath: string) => void
  /** Whether the message is currently streaming */
  isStreaming?: boolean
  /** Whether this item is still in progress (shows spinner) */
  isIncomplete?: boolean
}

/**
 * Collapsible container for multiple stacked items (thinking + tools)
 * Groups consecutive stackable items into a single visual block
 */
export function StackedGroup({
  items,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: StackedGroupProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useState(
    preferences?.expand_tool_calls_by_default ?? false
  )

  // Count thinking blocks and tools for summary
  let thinkingCount = 0
  const toolCounts = new Map<string, number>()
  for (const item of items) {
    if (item.type === 'thinking') {
      thinkingCount++
    } else {
      const name = getToolSummaryName(item.tool.name)
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    }
  }

  // Generate summary (e.g., "1 thinking, 2 Read" or "3 tools" or "2 thinking")
  const toolCount = items.length - thinkingCount
  const parts: string[] = []
  if (thinkingCount > 0) {
    parts.push(`${thinkingCount} thinking`)
  }
  if (toolCount > 0) {
    if (toolCounts.size === 1) {
      const [name] = toolCounts.keys()
      parts.push(`${toolCount} ${name}`)
    } else {
      parts.push(`${toolCount} tools`)
    }
  }
  const summary = parts.join(', ')

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn('min-w-0', className)}
    >
      <div
        className={cn(
          'rounded-md border border-border/50 bg-muted/30 min-w-0',
          isOpen && 'bg-muted/50'
        )}
      >
        <CollapsibleTrigger className={TOOL_CALL_ROW_CLASS}>
          <Layers className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium shrink-0 whitespace-nowrap">
            {summary}
          </span>
          {isStreaming && isIncomplete ? (
            <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
          ) : (
            <ChevronRight
              className={cn(
                'ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/50 px-3 py-2 space-y-1">
            {items.map((item, index) =>
              item.type === 'thinking' ? (
                <SubThinkingItem
                  key={`thinking-${index}`}
                  thinking={item.thinking}
                />
              ) : (
                <SubToolItem
                  key={item.tool.id}
                  toolCall={item.tool}
                  onFileClick={onFileClick}
                />
              )
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface SubThinkingItemProps {
  thinking: string
}

/**
 * Compact thinking item displayed within a StackedGroup
 * Similar style to SubToolItem but for thinking content
 */
function SubThinkingItem({ thinking }: SubThinkingItemProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useState(
    preferences?.expand_tool_calls_by_default ?? false
  )

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          'rounded border border-border/30 bg-background/50',
          isOpen && 'bg-muted/30'
        )}
      >
        <CollapsibleTrigger className={TOOL_CALL_SUB_ROW_CLASS}>
          <Brain className="h-3 w-3 shrink-0 text-purple-500" />
          <span className="font-medium shrink-0 whitespace-nowrap">
            Thinking
          </span>
          <ChevronRight
            className={cn(
              'ml-auto h-2.5 w-2.5 shrink-0 transition-transform duration-200',
              isOpen && 'rotate-90'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/30 px-2 py-1.5">
            <div className="pl-2 border-l-2 border-purple-500/30 text-[0.625rem] text-muted-foreground/70">
              <Markdown variant="tool-call">{thinking}</Markdown>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface SubToolItemProps {
  toolCall: ToolCall
  onFileClick?: (filePath: string) => void
}

/**
 * Compact sub-tool item displayed within a Task or ToolCallGroup
 * Even more minimal than ToolCallInline - just icon, label, and detail inline
 */
function SubToolItem({ toolCall, onFileClick }: SubToolItemProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useState(
    preferences?.expand_tool_calls_by_default ?? false
  )
  const { icon, label, detail, filePath, expandedContent } =
    getToolDisplay(toolCall)

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath && onFileClick) {
      onFileClick(filePath)
    }
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          'rounded border border-border/30 bg-background/50',
          isOpen && 'bg-muted/30'
        )}
      >
        <CollapsibleTrigger className={TOOL_CALL_SUB_ROW_CLASS}>
          <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">{icon}</span>
          <span className="font-medium shrink-0 flex-none whitespace-nowrap">
            {label}
          </span>
          {detail && filePath && onFileClick ? (
            <code
              role="button"
              tabIndex={0}
              onClick={handleFileClick}
              onKeyDown={e =>
                e.key === 'Enter' &&
                handleFileClick(e as unknown as React.MouseEvent)
              }
              className="inline-flex min-w-0 max-w-[55%] sm:max-w-full items-center gap-0.5 truncate rounded px-0.5 text-[0.625rem] font-sans leading-none hover:bg-primary/20 hover:text-primary transition-colors cursor-pointer"
            >
              <span className="truncate">{detail}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </code>
          ) : detail ? (
            <code className="min-w-0 max-w-[55%] sm:max-w-full truncate rounded px-0.5 text-[0.625rem] font-sans leading-none">
              {detail}
            </code>
          ) : null}
          <ChevronRight
            className={cn(
              'ml-auto h-2.5 w-2.5 shrink-0 transition-transform duration-200',
              isOpen && 'rotate-90'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/30 px-2 py-1.5">
            <div className="whitespace-pre-wrap text-[0.625rem] text-muted-foreground/70">
              {expandedContent}
            </div>
            {shouldRenderRawOutput(toolCall) && (
              <>
                <div className="border-t border-border/20 my-1.5" />
                <div className="text-[0.625rem] text-muted-foreground/50 mb-0.5">
                  Output:
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[0.625rem] font-mono text-foreground/70 bg-muted/30 rounded p-1.5">
                  {toolCall.output}
                </pre>
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface ToolDisplay {
  icon: React.ReactNode
  label: string
  detail?: React.ReactNode
  /** Full file path for file-related tools (Read, Edit, Write) */
  filePath?: string
  expandedContent: React.ReactNode
}

/** A single Codex file change entry */
interface CodexFileChange {
  diff?: string
  kind?: { type?: string; move_path?: string | null }
  path?: string
}

function parseCodexFileChanges(input: unknown): CodexFileChange[] {
  if (Array.isArray(input)) {
    return input as CodexFileChange[]
  }

  if (input && typeof input === 'object') {
    return [input as CodexFileChange]
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      if (Array.isArray(parsed)) {
        return parsed as CodexFileChange[]
      }
      if (parsed && typeof parsed === 'object') {
        return [parsed as CodexFileChange]
      }
    } catch {
      return []
    }
  }

  return []
}

/** Renders one or more Codex file changes with diffs */
function FileChangeDiffView({ input }: { input: unknown }) {
  const changes = parseCodexFileChanges(input)

  if (changes.length === 0) {
    return <span>No file changes</span>
  }

  return (
    <div className="space-y-3">
      {changes.map((change, idx) => {
        const filename = change.path
          ? getFilename(change.path)
          : `file ${idx + 1}`
        const changeType = change.kind?.type ?? 'update'

        return (
          <div key={change.path ?? idx}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="font-mono truncate text-muted-foreground">
                {filename}
              </span>
              <span className="text-[0.625rem] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {changeType}
              </span>
              {change.kind?.move_path && (
                <span className="text-muted-foreground/60 truncate">
                  → {getFilename(change.kind.move_path)}
                </span>
              )}
            </div>
            {change.diff ? (
              <InlineFileDiff patch={change.diff} filePath={change.path} />
            ) : (
              <div className="text-muted-foreground/50 italic">
                No diff available
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatWakeupDelay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`
}

export function normalizeToolCallForDisplay(
  name: string,
  input: Record<string, unknown>
): { name: string; input: Record<string, unknown> } {
  const variant = typeof input.variant === 'string' ? input.variant : undefined
  const normalizedName = (() => {
    switch (variant) {
      case 'ReadFile':
      case 'CursorRead':
        return 'Read'
      case 'Write':
      case 'CursorWrite':
        return 'Write'
      case 'SearchReplace':
      case 'CursorStrReplace':
        return 'Edit'
      case 'Bash':
      case 'CursorShell':
        return 'Bash'
      case 'Grep':
      case 'CursorGrep':
        return 'Grep'
      case 'CursorGlob':
        return 'Glob'
      case 'ListDir':
        return 'List'
      case 'TodoWrite':
      case 'CursorTodoWrite':
        return 'TodoWrite'
      case 'Task':
        return 'Task'
      case 'TaskOutput':
        return 'WaitForAgents'
      case 'WebFetch':
      case 'WebSearch':
      case 'EnterPlanMode':
      case 'ExitPlanMode':
        return variant
      default:
        return name
    }
  })()

  const withoutVariant = { ...input }
  delete withoutVariant.variant

  switch (normalizedName) {
    case 'read_file':
    case 'Read':
      return {
        name: 'Read',
        input: {
          ...withoutVariant,
          file_path:
            input.file_path ??
            input.target_file ??
            input.absolutePath ??
            input.filePath ??
            input.path,
        },
      }
    case 'write_file':
    case 'Write':
      return {
        name: 'Write',
        input: {
          ...withoutVariant,
          file_path:
            input.file_path ??
            input.target_file ??
            input.filePath ??
            input.absolutePath ??
            input.path,
          content: input.content ?? input.contents,
        },
      }
    case 'Edit':
      return {
        name: 'Edit',
        input: {
          ...withoutVariant,
          file_path:
            input.file_path ??
            input.target_file ??
            input.filePath ??
            input.path,
          old_string: input.old_string ?? input.oldText ?? input.old_text,
          new_string: input.new_string ?? input.newText ?? input.new_text,
        },
      }
    case 'read_multiple_files':
      return {
        name: 'ReadMultipleFiles',
        input: {
          ...input,
          path: input.path ?? input.targetDirectory,
        },
      }
    case 'shell_command':
      return { name: 'Bash', input }
    case 'read_directory':
      return { name: 'List', input }
    case 'glob':
    case 'Glob':
      return {
        name: 'Glob',
        input: {
          ...withoutVariant,
          pattern: input.pattern ?? input.glob_pattern ?? input.glob,
          path: input.path ?? input.target_directory ?? input.targetDirectory,
        },
      }
    case 'grep':
      return { name: 'Grep', input }
    case 'List':
      return {
        name: 'List',
        input: {
          ...withoutVariant,
          path: input.path ?? input.target_directory ?? input.targetDirectory,
        },
      }
    case 'WaitForAgents':
      return {
        name: 'WaitForAgents',
        input: {
          ...withoutVariant,
          receiver_thread_ids: input.receiver_thread_ids ?? input.task_ids,
        },
      }
    default:
      return { name: normalizedName, input: withoutVariant }
  }
}

function getToolSummaryName(name: string): string {
  return normalizeToolCallForDisplay(name, {}).name
}

/** Live-ticking remaining seconds for a pending ScheduleWakeup. */
function useWakeupRemaining(fireAtUnix: number | undefined): number | null {
  const [nowUnix, setNowUnix] = useState<number | null>(null)
  const updateNow = useCallback(
    () => setNowUnix(Math.floor(Date.now() / 1000)),
    []
  )

  useEffect(() => {
    if (!fireAtUnix) setNowUnix(null)
  }, [fireAtUnix])

  useVisibilityAwareTicker(!!fireAtUnix, updateNow)

  if (!fireAtUnix) return null
  if (nowUnix === null) return null
  return Math.max(0, fireAtUnix - nowUnix)
}

interface ScheduleWakeupIndicatorProps {
  toolCallId: string
  fallbackDelaySeconds?: number
}

/** Collapsed-row icon that reflects ScheduleWakeup status (pending/fired/cancelled).
 *
 * The wakeup scheduler in Rust emits `chat:wakeup_scheduled` → pending, and
 * clears the entry from memory (not from chat history) when it fires or is
 * cancelled. On app reload the `list_pending_wakeups` hydration pass seeds
 * the store with every still-pending entry; anything *not* in the store by
 * that point is assumed to have already fired in a prior session, so we
 * render it as completed rather than spinning forever.
 */
function ScheduleWakeupIcon({ toolCallId }: ScheduleWakeupIndicatorProps) {
  const entry = useChatStore(state => state.scheduledWakeups[toolCallId])
  const status = entry?.status ?? 'fired'
  if (status === 'pending') {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
  }
  if (status === 'cancelled') {
    return <XCircle className="h-4 w-4 shrink-0" />
  }
  return <CheckCircle2 className="h-4 w-4 shrink-0" />
}

/** Collapsed-row detail text that live-ticks until fire_at_unix. */
function ScheduleWakeupCountdown({ toolCallId }: ScheduleWakeupIndicatorProps) {
  const entry = useChatStore(state => state.scheduledWakeups[toolCallId])
  const remaining = useWakeupRemaining(entry?.fire_at_unix)
  const status = entry?.status ?? 'fired'
  if (status === 'cancelled') return <span>cancelled</span>
  if (status === 'pending') {
    if (remaining === null) return null
    if (remaining <= 0) return <span>firing…</span>
    return <span>fires in {formatWakeupDelay(remaining)}</span>
  }
  return <span>fired</span>
}

function getToolDisplay(toolCall: ToolCall): ToolDisplay {
  const normalized = normalizeToolCallForDisplay(
    toolCall.name,
    (toolCall.input ?? {}) as Record<string, unknown>
  )
  const input = normalized.input

  switch (normalized.name) {
    case 'Read': {
      const filePath = input.file_path as string | undefined
      const filename = filePath ? getFilename(filePath) : filePath
      const limit = input.limit as number | undefined
      const offset = input.offset as number | undefined
      const lineInfo = limit ? `${limit} lines` : ''
      return {
        icon: <FileText className="h-4 w-4 shrink-0" />,
        label: lineInfo ? `Read ${lineInfo}` : 'Read',
        detail: filename,
        filePath,
        expandedContent: filePath
          ? `Path: ${filePath}${offset ? `\nOffset: ${offset}` : ''}${limit ? `\nLimit: ${limit}` : ''}`
          : 'No file path specified',
      }
    }

    case 'Edit': {
      const filePath = input.file_path as string | undefined
      const filename = filePath ? getFilename(filePath) : filePath
      const oldString = input.old_string as string | undefined
      const newString = input.new_string as string | undefined
      return {
        icon: <Edit className="h-4 w-4 shrink-0" />,
        label: 'Edit',
        detail: filename,
        filePath,
        expandedContent: filePath ? (
          <InlineFileDiff
            filePath={filePath}
            oldString={oldString ?? ''}
            newString={newString ?? ''}
          />
        ) : (
          'No file path specified'
        ),
      }
    }

    case 'Write': {
      const filePath = input.file_path as string | undefined
      const filename = filePath ? getFilename(filePath) : filePath
      const content = input.content as string | undefined
      return {
        icon: <PenLine className="h-4 w-4 shrink-0" />,
        label: 'Write',
        detail: filename,
        filePath,
        expandedContent: filePath
          ? `Path: ${filePath}\n\nContent:\n${content ?? '(empty)'}`
          : 'No file path specified',
      }
    }

    case 'Bash': {
      const command = input.command as string | undefined
      const description = input.description as string | undefined
      // Truncate long commands for display
      const truncatedCommand =
        command && command.length > 50
          ? command.substring(0, 50) + '...'
          : command
      return {
        icon: <Terminal className="h-4 w-4 shrink-0" />,
        label: 'Bash',
        detail: truncatedCommand,
        expandedContent: description
          ? `${description}\n\n$ ${command}`
          : `$ ${command ?? '(no command)'}`,
      }
    }

    case 'Grep': {
      const pattern = input.pattern as string | undefined
      const path = input.path as string | undefined
      const glob = input.glob as string | undefined
      return {
        icon: <Search className="h-4 w-4 shrink-0" />,
        label: 'Grep',
        detail: pattern
          ? `"${pattern}"${path ? ` in ${path}` : ''}`
          : undefined,
        expandedContent: `Pattern: ${pattern ?? '(none)'}\nPath: ${path ?? '(cwd)'}\n${glob ? `Glob: ${glob}` : ''}`,
      }
    }

    case 'ToolSearch': {
      const query = input.query as string | undefined
      const maxResults =
        (input.max_results as number | undefined) ??
        (input.maxResults as number | undefined)
      return {
        icon: <Search className="h-4 w-4 shrink-0" />,
        label: 'Tool Search',
        detail: query,
        expandedContent: `Query: ${query ?? '(none)'}${typeof maxResults === 'number' ? `\nMax results: ${maxResults}` : ''}`,
      }
    }

    case 'Glob': {
      const pattern = input.pattern as string | undefined
      const path = input.path as string | undefined
      return {
        icon: <Folder className="h-4 w-4 shrink-0" />,
        label: 'Glob',
        detail: pattern,
        expandedContent: `Pattern: ${pattern ?? '(none)'}\nPath: ${path ?? '(cwd)'}`,
      }
    }

    case 'ReadMultipleFiles': {
      const path = input.path as string | undefined
      const include = input.include
      const includeText = Array.isArray(include)
        ? include.join(', ')
        : typeof include === 'string'
          ? include
          : undefined
      const detail =
        includeText && path
          ? `${includeText} in ${path}`
          : (includeText ?? path)
      return {
        icon: <FileText className="h-4 w-4 shrink-0" />,
        label: 'Read Multiple Files',
        detail,
        expandedContent: `Path: ${path ?? '(cwd)'}${includeText ? `\nInclude: ${includeText}` : ''}`,
      }
    }

    case 'Agent':
    case 'Task': {
      const subagentType = input.subagent_type as string | undefined
      const description = input.description as string | undefined
      const prompt = input.prompt as string | undefined
      const toolLabel = toolCall.name === 'Agent' ? 'Agent' : 'Task'
      return {
        icon: <Bot className="h-4 w-4 shrink-0" />,
        label: subagentType ? `${toolLabel} (${subagentType})` : toolLabel,
        detail: description,
        expandedContent: prompt ?? description ?? 'No prompt specified',
      }
    }

    case 'WebFetch':
    case 'WebSearch': {
      const url = input.url as string | undefined
      const query = input.query as string | undefined
      const prompt = input.prompt as string | undefined
      return {
        icon: <Globe className="h-4 w-4 shrink-0" />,
        label: toolCall.name,
        detail: url ?? query,
        expandedContent: url
          ? `URL: ${url}${prompt ? `\n\nPrompt: ${prompt}` : ''}`
          : `Query: ${query ?? '(none)'}`,
      }
    }

    // Codex multi-agent tools
    case 'SpawnAgent': {
      const prompt = input.prompt as string | undefined
      const truncatedPrompt =
        prompt && prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt
      return {
        icon: <Users className="h-4 w-4 shrink-0" />,
        label: 'Spawn Agent',
        detail: truncatedPrompt ?? 'sub-agent',
        expandedContent: prompt ?? JSON.stringify(input, null, 2),
      }
    }

    case 'SendInput': {
      const agentId = input.agent_id as string | undefined
      return {
        icon: <Send className="h-4 w-4 shrink-0" />,
        label: 'Send Input',
        detail: agentId ? `to agent ${agentId}` : undefined,
        expandedContent: JSON.stringify(input, null, 2),
      }
    }

    case 'WaitForAgents': {
      const receiverIds = (input.receiver_thread_ids ??
        input.receiverThreadIds) as string[] | undefined
      return {
        icon: <Clock className="h-4 w-4 shrink-0" />,
        label: 'Waiting for Agents',
        detail: receiverIds?.length
          ? `${receiverIds.length} agent${receiverIds.length === 1 ? '' : 's'}`
          : undefined,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'CloseAgent': {
      const agentId = input.agent_id as string | undefined
      return {
        icon: <XCircle className="h-4 w-4 shrink-0" />,
        label: 'Close Agent',
        detail: agentId,
        expandedContent: JSON.stringify(input, null, 2),
      }
    }

    case 'TodoWrite':
    case 'todo_write':
    case 'todowrite': {
      const todos = (Array.isArray(input.todos) ? input.todos : []) as {
        content?: string
        activeForm?: string
        status?: string
      }[]
      const completed = todos.filter(t => t.status === 'completed').length
      return {
        icon: <ListTodo className="h-4 w-4 shrink-0" />,
        label: 'Tasks',
        detail: todos.length ? `${completed}/${todos.length} done` : undefined,
        expandedContent: todos.length ? (
          <div className="space-y-1">
            {todos.map((todo, index) => {
              const text =
                todo.status === 'in_progress'
                  ? (todo.activeForm ?? todo.content ?? '')
                  : (todo.content ?? '')
              const done = todo.status === 'completed'
              const cancelled = todo.status === 'cancelled'
              const active = todo.status === 'in_progress'
              return (
                <div
                  key={`${text}-${index}`}
                  className="flex items-center gap-1.5"
                >
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                  ) : cancelled ? (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : active ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span
                    className={
                      done
                        ? 'line-through text-muted-foreground/60'
                        : cancelled
                          ? 'text-muted-foreground/60'
                          : ''
                    }
                  >
                    {text}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          'No items'
        ),
      }
    }

    case 'CodexTodoList': {
      const items = input.items as
        | { text: string; completed: boolean }[]
        | undefined
      return {
        icon: <ListTodo className="h-4 w-4 shrink-0" />,
        label: 'Todo List',
        detail: items?.length
          ? `${items.filter(i => i.completed).length}/${items.length} done`
          : undefined,
        expandedContent: items?.length ? (
          <div className="space-y-1">
            {items.map(item => (
              <div key={item.text} className="flex items-center gap-1.5">
                {item.completed ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                ) : (
                  <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                )}
                <span
                  className={
                    item.completed
                      ? 'line-through text-muted-foreground/60'
                      : ''
                  }
                >
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        ) : (
          'No items'
        ),
      }
    }

    case 'FileChange': {
      // Codex file_change items — input is the raw "changes" JSON
      const changes =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {}
      const filePath = (changes.file ?? changes.path ?? changes.file_path) as
        | string
        | undefined
      const fallbackChanges = !filePath
        ? parseCodexFileChanges(toolCall.output)
        : []
      const fallbackFilePath =
        fallbackChanges.length === 1
          ? (fallbackChanges[0]?.path as string | undefined)
          : undefined
      const filename = filePath ? getFilename(filePath) : undefined

      // If input is an array of changes, summarize
      const isArray = Array.isArray(toolCall.input)
      const isFallbackArray = !isArray && fallbackChanges.length > 1
      const fileCount = isArray
        ? (toolCall.input as unknown[]).length
        : isFallbackArray
          ? fallbackChanges.length
          : undefined
      const detail =
        isArray || isFallbackArray
          ? `${fileCount} file${fileCount === 1 ? '' : 's'}`
          : (filename ??
            (fallbackFilePath ? getFilename(fallbackFilePath) : undefined))

      return {
        icon: <FileText className="h-4 w-4 shrink-0" />,
        label: 'File Change',
        detail,
        filePath: filePath ?? fallbackFilePath,
        expandedContent: (
          <FileChangeDiffView
            input={toolCall.input ?? toolCall.output ?? null}
          />
        ),
      }
    }

    case 'EnterPlanMode': {
      const title = input.title as string | undefined
      const instructions = Array.isArray(input.instructions)
        ? input.instructions.filter(
            (instruction): instruction is string =>
              typeof instruction === 'string' && instruction.trim().length > 0
          )
        : []
      const banner = input.banner as string | undefined
      const markdownBody =
        instructions.length > 0
          ? `${title ?? 'Plan mode instructions'}:\n${instructions
              .map(instruction => `- ${instruction}`)
              .join('\n')}`
          : (banner ?? 'Switched to plan mode')
      return {
        icon: <Brain className="h-4 w-4 shrink-0" />,
        label: 'Entered plan mode',
        detail:
          instructions.length > 0
            ? 'Read-only analysis instructions'
            : undefined,
        expandedContent: (
          <Markdown variant="tool-call">{markdownBody}</Markdown>
        ),
      }
    }

    case 'Skill': {
      const skillName = input.skill as string | undefined
      const args = input.args
      const argsDetail =
        typeof args === 'string'
          ? args
          : args
            ? JSON.stringify(args)
            : undefined
      const expandedArgs =
        typeof args === 'string'
          ? args
          : args
            ? JSON.stringify(args, null, 2)
            : undefined
      return {
        icon: <Wand2 className="h-4 w-4 shrink-0 text-purple-500" />,
        label: skillName ? `Skill: ${skillName}` : 'Skill',
        detail: argsDetail,
        expandedContent: (
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="font-medium">
              {skillName ? `Skill: ${skillName}` : 'Skill'}
            </div>
            {expandedArgs && (
              <pre className="whitespace-pre-wrap font-mono rounded bg-muted/50 px-2 py-1">
                {expandedArgs}
              </pre>
            )}
          </div>
        ),
      }
    }

    // OpenCode-only tools
    case 'apply_patch': {
      const patchText = input.patchText as string | undefined
      const fileCount = patchText
        ? (patchText.match(/^---\s/gm) || []).length
        : 0
      return {
        icon: <FileCode className="h-4 w-4 shrink-0" />,
        label: 'Apply Patch',
        detail:
          fileCount > 0
            ? `${fileCount} file${fileCount === 1 ? '' : 's'}`
            : undefined,
        expandedContent: patchText ? patchText : 'No patch text',
      }
    }

    case 'multiedit': {
      const edits = input.edits as { filePath?: string }[] | undefined
      const fileCount = edits?.length ?? 0
      return {
        icon: <Edit className="h-4 w-4 shrink-0" />,
        label: 'Multi Edit',
        detail:
          fileCount > 0
            ? `${fileCount} edit${fileCount === 1 ? '' : 's'}`
            : undefined,
        expandedContent: JSON.stringify(input, null, 2),
      }
    }

    case 'CodeSearch': {
      const query = input.query as string | undefined
      return {
        icon: <Search className="h-4 w-4 shrink-0" />,
        label: 'Code Search',
        detail: query,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'List':
    case 'list': {
      const path = input.path as string | undefined
      return {
        icon: <List className="h-4 w-4 shrink-0" />,
        label: 'List',
        detail: path,
        expandedContent: toolCall.output ?? `Path: ${path ?? '(cwd)'}`,
      }
    }

    case 'lsp': {
      const action = input.action as string | undefined
      const filePath = input.filePath as string | undefined
      const filename = filePath ? getFilename(filePath) : undefined
      return {
        icon: <Code className="h-4 w-4 shrink-0" />,
        label: 'LSP',
        detail: action
          ? `${action}${filename ? ` ${filename}` : ''}`
          : filename,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'CodexWebSearch': {
      const query = input.query as string | undefined
      return {
        icon: <Globe className="h-4 w-4 shrink-0" />,
        label: 'Web Search',
        detail: query,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'CodexImageGeneration': {
      const prompt = input.prompt as string | undefined
      return {
        icon: <ImageIcon className="h-4 w-4 shrink-0" />,
        label: 'Image Generation',
        detail: prompt,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'CodexImageView': {
      return {
        icon: <ImageIcon className="h-4 w-4 shrink-0" />,
        label: 'Image View',
        detail: undefined,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'CodexContextCompaction': {
      return {
        icon: <Layers className="h-4 w-4 shrink-0" />,
        label: 'Context Compaction',
        detail: undefined,
        expandedContent: toolCall.output ?? JSON.stringify(input, null, 2),
      }
    }

    case 'ScheduleWakeup': {
      const delaySeconds =
        typeof input.delaySeconds === 'number' ? input.delaySeconds : undefined
      const prompt = typeof input.prompt === 'string' ? input.prompt : undefined
      const reason = typeof input.reason === 'string' ? input.reason : undefined
      const bodyParts: string[] = []
      if (reason) bodyParts.push(`**Reason:** ${reason}`)
      if (prompt) bodyParts.push(`**Prompt:**\n\n${prompt}`)
      const markdownBody = bodyParts.join('\n\n')
      return {
        icon: (
          <ScheduleWakeupIcon
            toolCallId={toolCall.id}
            fallbackDelaySeconds={delaySeconds}
          />
        ),
        label: 'Scheduled Wakeup',
        detail: (
          <ScheduleWakeupCountdown
            toolCallId={toolCall.id}
            fallbackDelaySeconds={delaySeconds}
          />
        ),
        expandedContent: markdownBody ? (
          <Markdown variant="tool-call">{markdownBody}</Markdown>
        ) : (
          JSON.stringify(input, null, 2)
        ),
      }
    }

    case 'Monitor': {
      const description =
        typeof input.description === 'string' ? input.description : undefined
      const command =
        typeof input.command === 'string' ? input.command : undefined
      // Live events come from Zustand during an active run. After reload,
      // events are reconstructed from tool_call.output (multi-line string
      // written by parse_run_to_message). Each line is "<unix_ms>|<text>"
      // so real relative timestamps survive session reload.
      let events = toolCall.events ?? []
      if (events.length === 0 && toolCall.output) {
        events = toolCall.output
          .split('\n')
          .filter(l => l.length > 0)
          .map((line, idx) => {
            const sep = line.indexOf('|')
            if (sep > 0) {
              const tsStr = line.slice(0, sep)
              const text = line.slice(sep + 1)
              const ts = Number.parseInt(tsStr, 10)
              if (Number.isFinite(ts)) {
                return {
                  kind: 'monitor_event' as const,
                  payload: { text },
                  ts_ms: ts,
                }
              }
            }
            return {
              kind: 'monitor_event' as const,
              payload: { text: line },
              ts_ms: idx,
            }
          })
      }
      const status: NonNullable<ToolCall['status']> =
        toolCall.status ??
        (toolCall.output ? 'done' : events.length > 0 ? 'running' : 'armed')
      const label = description ? `Monitor: ${description}` : 'Monitor'
      return {
        icon: <Activity className="h-4 w-4 shrink-0" />,
        label,
        detail: (
          <MonitorStatusBadge status={status} eventCount={events.length} />
        ),
        expandedContent: (
          <MonitorExpanded command={command} events={events} status={status} />
        ),
      }
    }

    default: {
      const isMcpTool = normalized.name.startsWith('mcp__')
      return {
        icon: <Terminal className="h-4 w-4 shrink-0" />,
        label: isMcpTool
          ? normalized.name
          : `${normalized.name} (unhandled tool)`,
        detail: undefined,
        expandedContent: JSON.stringify(input, null, 2),
      }
    }
  }
}

// -- Monitor renderer helpers ------------------------------------------------

function MonitorStatusBadge({
  status,
  eventCount,
}: {
  status: NonNullable<ToolCall['status']>
  eventCount: number
}) {
  const tone =
    status === 'done'
      ? 'text-green-600 dark:text-green-400'
      : status === 'error' || status === 'timeout'
        ? 'text-red-600 dark:text-red-400'
        : 'text-amber-600 dark:text-amber-400'
  const label =
    status === 'armed' ? 'armed' : status === 'running' ? 'running' : status
  return (
    <span className={cn('font-mono text-[11px]', tone)}>
      {label}
      {eventCount > 0
        ? ` · ${eventCount} event${eventCount === 1 ? '' : 's'}`
        : ''}
    </span>
  )
}

function MonitorExpanded({
  command,
  events,
  status,
}: {
  command: string | undefined
  events: NonNullable<ToolCall['events']>
  status: NonNullable<ToolCall['status']>
}) {
  const isActive =
    status !== 'done' && status !== 'error' && status !== 'timeout'
  return (
    <div className="space-y-2">
      {command ? (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Command
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
            {command}
          </pre>
        </div>
      ) : null}
      <div>
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Live events</span>
          {isActive ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>
        {events.length === 0 ? (
          <div className="mt-1 text-[11px] italic text-muted-foreground">
            {status === 'armed' ? 'Waiting for events…' : 'No events emitted.'}
          </div>
        ) : (
          <div className="mt-1 max-h-64 divide-y divide-border/30 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
            {events.map((ev, i) => {
              const text = formatMonitorEventText(ev)
              return (
                <div
                  key={`${ev.ts_ms}-${i}`}
                  className="py-1 first:pt-0 last:pb-0"
                >
                  <span
                    className={cn(
                      'whitespace-pre-wrap break-all',
                      ev.kind === 'monitor_status' &&
                        'text-amber-600 dark:text-amber-400',
                      ev.kind === 'monitor_done' &&
                        'text-green-600 dark:text-green-400'
                    )}
                  >
                    {text}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function formatMonitorEventText(
  ev: NonNullable<ToolCall['events']>[number]
): string {
  const p = ev.payload as Record<string, unknown> | null

  // System-lifecycle events from Claude CLI:
  //   { type: "system", subtype: "task_started" | "task_updated" | "task_notification", ... }
  if (p && (p.type === 'system' || typeof p.subtype === 'string')) {
    const subtype =
      typeof p.subtype === 'string' ? (p.subtype as string) : undefined
    if (subtype === 'task_started') {
      const desc = typeof p.description === 'string' ? p.description : ''
      return `task started${desc ? ` — ${desc}` : ''}`
    }
    if (subtype === 'task_updated') {
      const patch = (p.patch as Record<string, unknown> | undefined) ?? {}
      const status =
        typeof patch.status === 'string' ? (patch.status as string) : 'updated'
      return `task ${status}`
    }
    if (subtype === 'task_notification') {
      const status =
        typeof p.status === 'string' ? (p.status as string) : 'update'
      const summary = typeof p.summary === 'string' ? p.summary : ''
      return `${status}${summary ? ` — ${summary}` : ''}`
    }
  }

  if (ev.kind === 'monitor_status') {
    const status = (p as { status?: string } | null)?.status
    return `status: ${status ?? 'unknown'}`
  }
  if (ev.kind === 'monitor_done') {
    const status = (p as { status?: string } | null)?.status
    return `monitor ${status ?? 'done'}`
  }

  // monitor_event: payload may be a tool_result block ({content: string | array}),
  // an assistant-text payload ({type:"text", text}), or a system notification.
  if (p) {
    // Direct text-ish fields (assistant-text payload, system summary, etc.)
    for (const key of ['text', 'summary', 'line', 'output', 'message']) {
      const v = p[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
    // tool_result.content as string
    const content = p.content
    if (typeof content === 'string' && content.length > 0) return content
    // tool_result.content as array → concat text fields with real newlines
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const item of content) {
        if (item && typeof item === 'object') {
          const t = (item as { text?: unknown }).text
          if (typeof t === 'string') parts.push(t)
        }
      }
      if (parts.length > 0) return parts.join('\n')
    }
    // Nested message.content[].text (for user-message broadcasts)
    const nested = (p as { message?: { content?: unknown } }).message?.content
    if (Array.isArray(nested)) {
      const parts: string[] = []
      for (const b of nested) {
        if (b && typeof b === 'object') {
          const t = (b as { text?: unknown }).text
          if (typeof t === 'string') parts.push(t)
        }
      }
      if (parts.length > 0) return parts.join('\n')
    }
  }
  try {
    return JSON.stringify(ev.payload)
  } catch {
    return '(event)'
  }
}
