import { memo, useCallback, useEffect, useMemo, useState } from 'react'
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
  type LucideIcon,
} from '@/components/icons/reicon'
import type { ToolCall } from '@/types/chat'
import type { StackableItem } from './tool-call-utils'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import { getFilename } from '@/lib/path-utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { InlineFileDiff } from './InlineFileDiff'
import {
  codexSubagentDetail,
  formatSubagentModel,
} from './hooks/useActiveTodosAndAgents'

// Streaming tool calls are replaced by persisted message tool calls when a run
// finishes. Keep explicit user choices through that remount so an open tool
// does not close while the user is reading it.
const rememberedExpansion = new Map<string, boolean>()
const MAX_REMEMBERED_EXPANSIONS = 1000

function useRememberedExpansion(key: string, defaultOpen: boolean) {
  const [isOpen, setIsOpenState] = useState(
    () => rememberedExpansion.get(key) ?? defaultOpen
  )
  const setIsOpen = useCallback(
    (open: boolean) => {
      if (
        !rememberedExpansion.has(key) &&
        rememberedExpansion.size >= MAX_REMEMBERED_EXPANSIONS
      ) {
        const oldestKey = rememberedExpansion.keys().next().value
        if (oldestKey) rememberedExpansion.delete(oldestKey)
      }
      rememberedExpansion.set(key, open)
      setIsOpenState(open)
    },
    [key]
  )

  return [isOpen, setIsOpen] as const
}

/** Placeholder outputs that add no value next to already-rendered tool details. */
function isPlaceholderToolOutput(output: string | undefined | null): boolean {
  if (!output) return true
  const trimmed = output.trim().toLowerCase()
  return (
    trimmed === '' ||
    trimmed === 'completed' ||
    trimmed === 'ok' ||
    trimmed === 'success' ||
    trimmed === 'context compacted'
  )
}

function shouldRenderRawOutput(toolCall: ToolCall): boolean {
  if (!toolCall.output?.trim()) return false
  if (isPlaceholderToolOutput(toolCall.output)) return false
  const input = (toolCall.input ?? {}) as Record<string, unknown>
  const normalizedName = normalizeToolCallForDisplay(toolCall.name, input).name
  // These tools already surface output (results/path/etc.) in expandedContent.
  if (
    // Read contents can be huge and are dropped live; hide them in history too
    // so a row looks the same during streaming and after reload.
    normalizedName === 'Read' ||
    normalizedName === 'FileChange' ||
    normalizedName === 'Monitor' ||
    normalizedName === 'CodexWebSearch' ||
    normalizedName === 'CodexImageView' ||
    normalizedName === 'CodexImageGeneration' ||
    normalizedName === 'CodexContextCompaction' ||
    // Bash/shell expandedContent includes stdout when present (issue #572).
    normalizedName === 'Bash'
  ) {
    return false
  }
  return true
}

/** True when the backend reported the tool result as an error. */
export function isToolCallError(toolCall: ToolCall): boolean {
  if (toolCall.is_error !== true) return false
  // Claude flags any non-zero shell exit as an error, but the command did run
  // (e.g. grep with no match, `which` for a missing binary). Not a failure.
  const input = (toolCall.input ?? {}) as Record<string, unknown>
  if (
    normalizeToolCallForDisplay(toolCall.name, input).name === 'Bash' &&
    /^Exit code \d+/.test(toolCall.output ?? '')
  ) {
    return false
  }
  return true
}

/** Subtle "failed" marker for tool rows whose result was an error. */
function ToolErrorBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-destructive/80',
        compact ? 'text-[0.625rem]' : 'text-[0.6875rem]'
      )}
    >
      <XCircle className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      failed
    </span>
  )
}

/**
 * Expanded body for tools without a dedicated renderer: the input arguments.
 * Output is rendered once, by the raw "Output:" panel (shouldRenderRawOutput).
 */
function formatInputForExpanded(
  toolCall: ToolCall,
  input: Record<string, unknown>
): React.ReactNode {
  if (Object.keys(input).length > 0) return JSON.stringify(input, null, 2)
  if (shouldRenderRawOutput(toolCall)) return null
  // Placeholder outputs ("completed", "ok") are not shown in the raw panel.
  return toolCall.output?.trim() || 'No details available'
}

/** Readable details for Codex `sub_agent_activity` items (else undefined). */
function formatSubAgentActivity(
  input: Record<string, unknown>
): string | undefined {
  if (input.type !== 'sub_agent_activity') return undefined
  const threadIds = Array.isArray(input.receiver_thread_ids)
    ? (input.receiver_thread_ids as string[])
    : []
  const states = (input.agents_states ?? {}) as Record<
    string,
    { status?: string } | undefined
  >
  const name = codexSubagentDetail(input) ?? 'sub-agent'
  const lines = [`Agent: ${name}`]
  const model =
    typeof input.model === 'string' && input.model.trim()
      ? formatSubagentModel(input.model)
      : undefined
  if (model && !name.includes(model)) lines.push(`Model: ${model}`)
  for (const id of threadIds) {
    lines.push(`Thread: ${id}`)
    const status = states[id]?.status
    if (status) lines.push(`Status: ${status}`)
  }
  return lines.join('\n')
}

/** Best-effort one-line detail from common tool input fields. */
function firstStringField(
  input: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

interface SimpleToolSpec {
  label: string
  icon: LucideIcon
  /** Input fields tried in order for the one-line detail. */
  detailKeys?: string[]
}

/**
 * Claude Code tools that only need a label + key input detail. The expanded
 * body shows the input JSON and the raw "Output:" panel shows the result.
 * Input field names: https://code.claude.com/docs/en/tools-reference
 */
const SIMPLE_TOOL_SPECS: Record<string, SimpleToolSpec> = {
  BashOutput: { label: 'Bash Output', icon: Terminal, detailKeys: ['bash_id'] },
  TaskOutput: {
    label: 'Task Output',
    icon: Terminal,
    detailKeys: ['task_id', 'bash_id', 'id'],
  },
  KillShell: { label: 'Kill Shell', icon: XCircle, detailKeys: ['shell_id'] },
  KillBash: { label: 'Kill Shell', icon: XCircle, detailKeys: ['shell_id'] },
  TaskStop: {
    label: 'Stop Task',
    icon: XCircle,
    detailKeys: ['task_id', 'shell_id', 'id'],
  },
  PowerShell: {
    label: 'PowerShell',
    icon: Terminal,
    detailKeys: ['command', 'description'],
  },
  SendMessage: {
    label: 'Send Message',
    icon: Send,
    detailKeys: ['to', 'agent_id', 'name', 'summary'],
  },
  ListAgents: { label: 'List Agents', icon: Users },
  EnterWorktree: {
    label: 'Enter Worktree',
    icon: Folder,
    detailKeys: ['name', 'path'],
  },
  ExitWorktree: {
    label: 'Exit Worktree',
    icon: Folder,
    detailKeys: ['action'],
  },
  CronCreate: { label: 'Schedule Prompt', icon: Clock, detailKeys: ['cron'] },
  CronDelete: { label: 'Delete Schedule', icon: Clock, detailKeys: ['id'] },
  CronList: { label: 'List Schedules', icon: Clock },
  ListMcpResourcesTool: {
    label: 'List MCP Resources',
    icon: List,
    detailKeys: ['server'],
  },
  ReadMcpResourceTool: {
    label: 'Read MCP Resource',
    icon: FileText,
    detailKeys: ['uri', 'server'],
  },
  TaskCreate: {
    label: 'Create Task',
    icon: ListTodo,
    detailKeys: ['subject', 'title', 'description'],
  },
  TaskUpdate: {
    label: 'Update Task',
    icon: ListTodo,
    detailKeys: ['subject', 'title', 'status', 'taskId', 'task_id', 'id'],
  },
  TaskGet: {
    label: 'Get Task',
    icon: ListTodo,
    detailKeys: ['taskId', 'task_id', 'id'],
  },
  TaskList: { label: 'List Tasks', icon: ListTodo },
  Workflow: {
    label: 'Workflow',
    icon: Layers,
    detailKeys: ['description', 'name', 'title'],
  },
  PushNotification: {
    label: 'Push Notification',
    icon: Send,
    detailKeys: ['message', 'title', 'body'],
  },
  WaitForMcpServers: { label: 'Wait for MCP Servers', icon: Clock },
}

function getSimpleToolDetail(
  spec: SimpleToolSpec,
  input: Record<string, unknown>
): string | undefined {
  const detail = spec.detailKeys
    ? firstStringField(input, spec.detailKeys)
    : undefined
  if (detail) return detail.length > 60 ? `${detail.slice(0, 60)}…` : detail
  // e.g. WaitForMcpServers { servers: [...] }
  for (const value of Object.values(input)) {
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      return value.length > 0 ? value.join(', ') : undefined
    }
  }
  return undefined
}

/**
 * Strip MCP / client prefixes from a Jean tool name and return the bare registry name.
 * Handles: jean_get_current_context, jean-dev_list_projects, mcp:jean:list_worktrees,
 * mcp__jean__create_session, mcp__jean-dev__get_current_context.
 */
export function extractJeanMcpBareToolName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('mcp__')) {
    // mcp__jean__tool or mcp__jean-dev__tool (tool may contain underscores)
    const rest = trimmed.slice('mcp__'.length)
    const serverSep = rest.indexOf('__')
    if (serverSep > 0) {
      const server = rest.slice(0, serverSep)
      const tool = rest.slice(serverSep + 2)
      if (
        (server === 'jean' ||
          server === 'jean-dev' ||
          server.startsWith('jean')) &&
        tool
      ) {
        return tool
      }
    }
    return null
  }

  if (trimmed.startsWith('mcp:')) {
    // mcp:jean:tool or mcp:jean-dev:tool
    const parts = trimmed.split(':')
    if (parts.length >= 3) {
      const server = parts[1] ?? ''
      const tool = parts.slice(2).join(':')
      if (
        (server === 'jean' ||
          server === 'jean-dev' ||
          server.startsWith('jean')) &&
        tool
      ) {
        return tool
      }
    }
    return null
  }

  // Client-side prefix: jean_get_current_context / jean-dev_list_projects
  for (const prefix of ['jean-dev_', 'jean_']) {
    if (trimmed.startsWith(prefix)) {
      const bare = trimmed.slice(prefix.length)
      if (bare) return bare
    }
  }

  return null
}

export function isJeanMcpToolName(name: string): boolean {
  return extractJeanMcpBareToolName(name) != null
}

/** True for tools that should not get the "(unhandled tool)" suffix. */
function isRecognizedExternalTool(name: string): boolean {
  return (
    name.startsWith('mcp__') ||
    name.startsWith('mcp:') ||
    isAntigravityNativeToolName(name) ||
    isMuseNativeToolName(name) ||
    isJeanMcpToolName(name)
  )
}

/** Native Antigravity tools that use Jean's generic expandable renderer. */
function isAntigravityNativeToolName(name: string): boolean {
  return (
    name.startsWith('browser_') ||
    [
      'command_status',
      'generate_image',
      'list_browser_pages',
      'manage_inbox',
      'manage_subagents',
      'manage_task',
      'multi_replace_file_content',
      'notify_user',
      'open_browser_url',
      'read_browser_page',
      'read_knowledge_base_item',
      'read_terminal',
      'search_knowledge_base',
      'send_command_input',
      'task_boundary',
    ].includes(name)
  )
}

/** Native Muse Code tools that use Jean's generic expandable renderer. */
function isMuseNativeToolName(name: string): boolean {
  return [
    'add_memory',
    'bash_input',
    'code_exec',
    'code_wait',
    'cron_create',
    'cron_delete',
    'cron_list',
    'edit_memory',
    'search',
    'subagent_cancel',
    'update_goal',
    'work_stop',
    'write_todos',
  ].includes(name)
}

/** Title-case a snake_case / kebab-case tool id for display. */
function humanizeSnakeCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

/** Friendly label for a Jean MCP tool call. */
export function formatJeanMcpToolLabel(name: string): string {
  const bare = extractJeanMcpBareToolName(name) ?? name
  return `Jean: ${humanizeSnakeCase(bare)}`
}

/** Detail line for Jean MCP tools from common argument fields. */
export function formatJeanMcpToolDetail(
  input: Record<string, unknown>
): string | undefined {
  const parts: string[] = []
  const backend = firstStringField(input, ['backend'])
  const projectId = firstStringField(input, ['projectId', 'project_id'])
  const worktreeId = firstStringField(input, ['worktreeId', 'worktree_id'])
  const sessionId = firstStringField(input, ['sessionId', 'session_id'])
  const path = firstStringField(input, ['path'])
  const name = firstStringField(input, ['name', 'customName', 'custom_name'])
  const branch = firstStringField(input, [
    'baseBranch',
    'base_branch',
    'branchName',
    'branch_name',
  ])
  const model = firstStringField(input, ['model'])
  const message = firstStringField(input, ['message'])

  if (backend) parts.push(backend)
  if (name) parts.push(name)
  if (branch) parts.push(branch)
  if (model) parts.push(model)
  if (path) parts.push(path)
  if (message)
    parts.push(message.length > 40 ? `${message.slice(0, 40)}…` : message)
  // Short id suffixes only when nothing more descriptive is available
  if (parts.length === 0) {
    if (worktreeId) parts.push(`worktree ${worktreeId.slice(0, 8)}`)
    else if (projectId) parts.push(`project ${projectId.slice(0, 8)}`)
    else if (sessionId) parts.push(`session ${sessionId.slice(0, 8)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Unwrap meta tool wrappers (e.g. Grok/MCP bridge `use_tool`) that nest the
 * real tool name + args under tool_name / tool_input.
 */
function unwrapMetaToolCall(
  name: string,
  input: Record<string, unknown>
): { name: string; input: Record<string, unknown> } | null {
  const isMeta =
    name === 'use_tool' ||
    name === 'useTool' ||
    name === 'UseTool' ||
    name === 'call_tool' ||
    name === 'callTool' ||
    name === 'CallTool'
  if (!isMeta) return null

  const nestedName = firstStringField(input, [
    'tool_name',
    'toolName',
    'name',
    'tool',
  ])
  if (!nestedName) return null

  const rawNested =
    input.tool_input ??
    input.toolInput ??
    input.arguments ??
    input.args ??
    input.input ??
    input.parameters

  let nestedInput: Record<string, unknown> = {}
  if (rawNested && typeof rawNested === 'object' && !Array.isArray(rawNested)) {
    nestedInput = rawNested as Record<string, unknown>
  }

  return { name: nestedName, input: nestedInput }
}

function formatCodexWebSearchDetail(
  input: Record<string, unknown>
): string | undefined {
  const query = firstStringField(input, ['query'])
  if (query) return query

  const action =
    input.action && typeof input.action === 'object'
      ? (input.action as Record<string, unknown>)
      : undefined
  if (!action) return undefined

  const actionType = typeof action.type === 'string' ? action.type : undefined
  const actionQuery = firstStringField(action, ['query'])
  if (actionQuery) return actionQuery

  if (Array.isArray(action.queries)) {
    const queries = action.queries.filter(
      (q): q is string => typeof q === 'string' && q.trim().length > 0
    )
    if (queries.length > 0) return queries.join(', ')
  }

  const url = firstStringField(action, ['url'])
  if (url) {
    return actionType === 'findInPage' || actionType === 'find_in_page'
      ? firstStringField(action, ['pattern'])
        ? `${firstStringField(action, ['pattern'])} in ${url}`
        : url
      : url
  }

  const pattern = firstStringField(action, ['pattern'])
  if (pattern) return pattern

  return undefined
}

function formatCodexWebSearchExpanded(
  input: Record<string, unknown>,
  output: string | undefined
): string {
  const parts: string[] = []
  const query = firstStringField(input, ['query'])
  if (query) parts.push(`Query: ${query}`)

  const action =
    input.action && typeof input.action === 'object'
      ? (input.action as Record<string, unknown>)
      : undefined
  if (action) {
    const actionType = typeof action.type === 'string' ? action.type : 'action'
    const actionBits: string[] = [`Action: ${actionType}`]
    const actionQuery = firstStringField(action, ['query'])
    if (actionQuery) actionBits.push(`query=${actionQuery}`)
    if (Array.isArray(action.queries) && action.queries.length > 0) {
      actionBits.push(
        `queries=${action.queries
          .filter((q): q is string => typeof q === 'string')
          .join(', ')}`
      )
    }
    const url = firstStringField(action, ['url'])
    if (url) actionBits.push(`url=${url}`)
    const pattern = firstStringField(action, ['pattern'])
    if (pattern) actionBits.push(`pattern=${pattern}`)
    parts.push(actionBits.join(' · '))
  }

  if (input.results != null) {
    const resultsText =
      typeof input.results === 'string'
        ? input.results
        : JSON.stringify(input.results, null, 2)
    if (resultsText && resultsText !== 'null' && resultsText !== '[]') {
      parts.push(`Results:\n${resultsText}`)
    }
  }

  if (output && !isPlaceholderToolOutput(output)) {
    // Avoid duplicating results already shown from input.results
    if (!parts.some(p => p.includes(output))) {
      parts.push(output)
    }
  }

  if (parts.length === 0) {
    return JSON.stringify(input, null, 2)
  }
  return parts.join('\n\n')
}

// Single source of truth for tool call row layout. Bump min-h-9/px-2.5 here, all rows update.
// min-h ensures consistent baseline regardless of inline-content height (pill vs no-pill).
export const TOOL_CALL_ROW_CLASS =
  'tool-call-row flex min-h-9 w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 select-none min-w-0'

export const TOOL_CALL_SUB_ROW_CLASS =
  'tool-call-row flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/80 hover:bg-muted/30 select-none min-w-0'

// Detail pill — sits AFTER label, snug to content (no flex-1 stretch).
// Always font-sans: .font-mono forces --chat-font-size !important and blows
// Read/Edit/Write filenames up to message size while Grep/Bash stay compact.
export const TOOL_CALL_DETAIL_PILL_CLASS =
  'min-w-0 max-w-[55%] sm:max-w-full truncate rounded px-1 text-[0.6875rem] font-sans leading-none'

export const TOOL_CALL_SUB_DETAIL_PILL_CLASS =
  'min-w-0 max-w-[55%] sm:max-w-full truncate rounded px-0.5 text-[0.625rem] font-sans leading-none'

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
export const ToolCallInline = memo(function ToolCallInline({
  toolCall,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: ToolCallInlineProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useRememberedExpansion(
    `tool:${toolCall.id}`,
    preferences?.expand_tool_calls_by_default ?? false
  )
  // Builds JSON/diff content, so only recompute when the tool call changes
  const { icon, label, detail, filePath, expandedContent } = useMemo(
    () => getToolDisplay(toolCall),
    [toolCall]
  )

  const handleFileClick = (e: React.MouseEvent) => {
    e.preventDefault()
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
        <CollapsibleTrigger asChild>
          <div className={TOOL_CALL_ROW_CLASS}>
            {icon}
            <span className="font-medium shrink-0 flex-none whitespace-nowrap">
              {label}
            </span>
            {detail ? (
              <code className={TOOL_CALL_DETAIL_PILL_CLASS}>{detail}</code>
            ) : null}
            {filePath && onFileClick ? (
              <button
                type="button"
                onClick={handleFileClick}
                aria-label={`Open ${typeof detail === 'string' ? detail : filePath}`}
                className="inline-flex shrink-0 items-center rounded p-0.5 hover:bg-primary/20 hover:text-primary transition-colors"
              >
                <ExternalLink className="h-3 w-3 opacity-60" />
              </button>
            ) : null}
            {isToolCallError(toolCall) ? <ToolErrorBadge /> : null}
            <span className="ml-auto flex min-w-0 flex-1 items-center justify-end">
              {isStreaming && isIncomplete ? (
                <WorkingWaveform />
              ) : (
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 transition-transform duration-200',
                    isOpen && 'rotate-90'
                  )}
                />
              )}
            </span>
          </div>
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
})

interface TaskCallInlineProps {
  taskToolCall: ToolCall
  subToolCalls: ToolCall[]
  /** All tool calls in the message, used to resolve nested Task sub-tools */
  allToolCalls?: ToolCall[]
  /**
   * Sub-tools of nested Task/Agent calls keyed by their tool id, as resolved by
   * buildTimeline (includes its content-order fallback grouping). When absent,
   * nested sub-tools are resolved by parent_tool_use_id only.
   */
  nestedSubTools?: Record<string, ToolCall[]>
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
export const TaskCallInline = memo(function TaskCallInline({
  taskToolCall,
  subToolCalls,
  allToolCalls,
  nestedSubTools,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: TaskCallInlineProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useRememberedExpansion(
    `task:${taskToolCall.id}`,
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
          {isToolCallError(taskToolCall) ? <ToolErrorBadge /> : null}
          {/* Show sub-tool count badge */}
          {subToolCalls.length > 0 && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground/60">
              {subToolCalls.length} tool{subToolCalls.length === 1 ? '' : 's'}
            </span>
          )}
          {isStreaming && isIncomplete ? (
            <WorkingWaveform
              className={cn(subToolCalls.length === 0 && 'ml-auto')}
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
          <TaskCallDetails
            className="border-t border-border/50 px-3 py-2"
            prompt={prompt}
            report={report}
            subToolCalls={subToolCalls}
            allToolCalls={allToolCalls}
            nestedSubTools={nestedSubTools}
            onFileClick={onFileClick}
            isStreaming={isStreaming}
            isIncomplete={isIncomplete}
          />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})

const EMPTY_TOOL_CALLS: ToolCall[] = []

interface TaskCallDetailsProps {
  /** Instructions given to the subagent */
  prompt?: string
  /** Final report the subagent returned */
  report?: string
  subToolCalls: ToolCall[]
  allToolCalls?: ToolCall[]
  nestedSubTools?: Record<string, ToolCall[]>
  className?: string
  onFileClick?: (filePath: string) => void
  isStreaming?: boolean
  isIncomplete?: boolean
}

/**
 * Expanded subagent body: prompt, sub-tool calls, and final report.
 * Shared by TaskCallInline and the Subagents panel above the input.
 */
export function TaskCallDetails({
  prompt,
  report,
  subToolCalls,
  allToolCalls,
  nestedSubTools,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: TaskCallDetailsProps) {
  // Group once so nested Task rows get stable sub-tool arrays per render
  const subToolsByParent = useMemo(() => {
    const byParent = new Map<string, ToolCall[]>()
    for (const tc of allToolCalls ?? []) {
      if (!tc.parent_tool_use_id) continue
      const calls = byParent.get(tc.parent_tool_use_id) ?? []
      calls.push(tc)
      byParent.set(tc.parent_tool_use_id, calls)
    }
    return byParent
  }, [allToolCalls])

  return (
    <div className={cn('space-y-2', className)}>
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
            (allToolCalls || nestedSubTools) ? (
              <TaskCallInline
                key={subTool.id}
                taskToolCall={subTool}
                subToolCalls={
                  nestedSubTools?.[subTool.id] ??
                  subToolsByParent.get(subTool.id) ??
                  EMPTY_TOOL_CALLS
                }
                allToolCalls={allToolCalls}
                nestedSubTools={nestedSubTools}
                onFileClick={onFileClick}
                isStreaming={isStreaming}
                // A nested agent is still running while its parent is
                // and it has not returned its report yet.
                isIncomplete={Boolean(isIncomplete) && !subTool.output?.trim()}
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
export const StackedGroup = memo(function StackedGroup({
  items,
  className,
  onFileClick,
  isStreaming,
  isIncomplete,
}: StackedGroupProps) {
  const { data: preferences } = usePreferences()
  const firstItem = items[0]
  const groupKey =
    firstItem?.type === 'thinking'
      ? firstItem.key
      : (firstItem?.tool.id ?? 'empty')
  const [isOpen, setIsOpen] = useRememberedExpansion(
    `stack:${groupKey}`,
    preferences?.expand_tool_calls_by_default ?? false
  )

  // Count thinking blocks and tools for summary
  let thinkingCount = 0
  const toolCounts = new Map<string, number>()
  for (const item of items) {
    if (item.type === 'thinking') {
      thinkingCount++
    } else {
      const name = getToolSummaryName(item.tool)
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
            <WorkingWaveform className="ml-auto" />
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
            {items.map(item =>
              item.type === 'thinking' ? (
                <SubThinkingItem key={item.key} thinking={item.thinking} />
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
})

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
          <Brain className="h-3 w-3 shrink-0 text-muted-foreground" />
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
            <div className="pl-2 border-l-2 border-border text-[0.625rem] text-muted-foreground/70">
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
const SubToolItem = memo(function SubToolItem({
  toolCall,
  onFileClick,
}: SubToolItemProps) {
  const { data: preferences } = usePreferences()
  const [isOpen, setIsOpen] = useRememberedExpansion(
    `subtool:${toolCall.id}`,
    preferences?.expand_tool_calls_by_default ?? false
  )
  // Builds JSON/diff content, so only recompute when the tool call changes
  const { icon, label, detail, filePath, expandedContent } = useMemo(
    () => getToolDisplay(toolCall),
    [toolCall]
  )

  const handleFileClick = (e: React.MouseEvent) => {
    e.preventDefault()
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
        <CollapsibleTrigger asChild>
          <div className={TOOL_CALL_SUB_ROW_CLASS}>
            <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">{icon}</span>
            <span className="font-medium shrink-0 flex-none whitespace-nowrap">
              {label}
            </span>
            {detail ? (
              <code className={TOOL_CALL_SUB_DETAIL_PILL_CLASS}>{detail}</code>
            ) : null}
            {filePath && onFileClick ? (
              <button
                type="button"
                onClick={handleFileClick}
                aria-label={`Open ${typeof detail === 'string' ? detail : filePath}`}
                className="inline-flex shrink-0 items-center rounded p-0.5 hover:bg-primary/20 hover:text-primary transition-colors"
              >
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </button>
            ) : null}
            {isToolCallError(toolCall) ? <ToolErrorBadge compact /> : null}
            <span className="ml-auto flex min-w-0 flex-1 items-center justify-end">
              <ChevronRight
                className={cn(
                  'h-2.5 w-2.5 transition-transform duration-200',
                  isOpen && 'rotate-90'
                )}
              />
            </span>
          </div>
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
})

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
        const changeKey =
          change.path ??
          `change:${changeType}:${change.kind?.move_path ?? ''}:${change.diff?.slice(0, 64) ?? ''}`

        return (
          <div key={changeKey}>
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
  // Unwrap meta wrappers (use_tool / call_tool) before other normalization so
  // Jean MCP and other nested tools get the right renderer.
  const unwrapped = unwrapMetaToolCall(name, input)
  if (unwrapped) {
    return normalizeToolCallForDisplay(unwrapped.name, unwrapped.input)
  }

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
    case 'Bash':
    case 'bash':
    case 'exec_command':
    case 'run_command':
    case 'shell_command':
    case 'run_terminal_command':
    case 'Shell':
    case 'shell':
    case 'execute':
      return {
        name: 'Bash',
        input: {
          ...withoutVariant,
          command: input.command ?? input.CommandLine ?? input.cmd,
        },
      }
    case 'view_file':
    case 'read_file':
    case 'read':
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
            input.AbsolutePath ??
            input.path,
        },
      }
    case 'write_to_file':
    case 'write_file':
    case 'write':
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
            input.TargetFile ??
            input.path,
          content: input.content ?? input.contents ?? input.CodeContent,
        },
      }
    case 'replace_file_content':
    case 'edit_file':
    case 'edit':
    case 'Edit':
      return {
        name: 'Edit',
        input: {
          ...withoutVariant,
          file_path:
            input.file_path ??
            input.target_file ??
            input.filePath ??
            input.TargetFile ??
            input.path,
          old_string:
            input.old_string ??
            input.oldText ??
            input.old_text ??
            input.old_str ??
            input.TargetContent,
          new_string:
            input.new_string ??
            input.newText ??
            input.new_text ??
            input.new_str ??
            input.ReplacementContent,
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
    case 'read_directory':
    case 'list_dir':
      return {
        name: 'List',
        input: {
          ...withoutVariant,
          path: input.path ?? input.DirectoryPath,
        },
      }
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
    case 'grep_search':
      return {
        name: 'Grep',
        input: {
          ...withoutVariant,
          pattern: input.pattern ?? input.Query,
          path: input.path ?? input.SearchPath,
        },
      }
    case 'find_by_name':
      return {
        name: 'Glob',
        input: {
          ...withoutVariant,
          pattern: input.pattern ?? input.Pattern,
          path: input.path ?? input.SearchDirectory,
        },
      }
    case 'search_web':
    case 'web_search':
      return {
        name: 'WebSearch',
        input: { ...withoutVariant, query: input.query ?? input.Query },
      }
    case 'read_url_content':
    case 'web_fetch':
      return {
        name: 'WebFetch',
        input: { ...withoutVariant, url: input.url ?? input.Url },
      }
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

function getToolSummaryName(toolCall: ToolCall): string {
  switch (toolCall.name) {
    case 'CodexWebSearch':
      return 'Web Search'
    case 'CodexImageGeneration':
      return 'Image Generation'
    case 'CodexImageView':
      return 'Image View'
    case 'CodexContextCompaction':
      return 'Context Compaction'
    case 'SpawnAgent':
      return 'Spawn Agent'
    case 'SendInput':
      return 'Send Input'
    case 'WaitForAgents':
      return 'Waiting for Agents'
    case 'CloseAgent':
      return 'Close Agent'
    default: {
      const normalized = normalizeToolCallForDisplay(
        toolCall.name,
        (toolCall.input ?? {}) as Record<string, unknown>
      ).name
      if (isJeanMcpToolName(normalized) || isJeanMcpToolName(toolCall.name)) {
        return formatJeanMcpToolLabel(normalized)
      }
      return SIMPLE_TOOL_SPECS[normalized]?.label ?? normalized
    }
  }
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Keep the end of long paths (the filename is the useful part). */
function truncatePathOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  if (/[/\\]/.test(oneLine)) return `…${oneLine.slice(-(max - 1))}`
  return `${oneLine.slice(0, max - 1)}…`
}

/**
 * One-line label/detail for a tool call. Shared by the compact streaming
 * ticker and the finished compact message list so both show the same text.
 */
export function summarizeToolCall(toolCall: ToolCall): {
  label: string
  detail?: string
} {
  const normalized = normalizeToolCallForDisplay(
    toolCall.name,
    (toolCall.input ?? {}) as Record<string, unknown>
  )
  const input = normalized.input
  const label = getToolSummaryName({ ...toolCall, name: normalized.name })

  if (
    normalized.name === 'SpawnAgent' ||
    normalized.name === 'SendInput' ||
    normalized.name === 'CloseAgent' ||
    normalized.name === 'ResumeAgent' ||
    normalized.name === 'WaitForAgents'
  ) {
    return { label, detail: codexSubagentDetail(input) }
  }

  if (isJeanMcpToolName(normalized.name)) {
    const detail = formatJeanMcpToolDetail(input)
    return { label, detail: detail ? truncateOneLine(detail, 80) : undefined }
  }

  const pathDetail = firstStringField(input, [
    'file_path',
    'notebook_path',
    'filePath',
    'path',
  ])
  if (pathDetail) {
    return { label, detail: truncatePathOneLine(pathDetail, 80) }
  }

  // Codex web search may nest the query under action
  const action =
    input.action && typeof input.action === 'object'
      ? (input.action as Record<string, unknown>)
      : undefined
  const spec = SIMPLE_TOOL_SPECS[normalized.name]
  const detail =
    firstStringField(input, ['query']) ??
    (action ? firstStringField(action, ['query', 'url']) : undefined) ??
    (spec ? getSimpleToolDetail(spec, input) : undefined) ??
    firstStringField(input, [
      'command',
      'url',
      'pattern',
      'description',
      'backend',
      'tool_name',
      'toolName',
      'prompt',
    ])
  return { label, detail: detail ? truncateOneLine(detail, 80) : undefined }
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
      const header = description
        ? `${description}\n\n$ ${command ?? '(no command)'}`
        : `$ ${command ?? '(no command)'}`
      // Surface stdout/stderr in the main expanded body so bash results are
      // visible without relying on a separate "Output:" panel (issue #572).
      const output = toolCall.output?.trim()
      const hasOutput = Boolean(output) && !isPlaceholderToolOutput(output)
      return {
        icon: <Terminal className="h-4 w-4 shrink-0" />,
        label: 'Bash',
        detail: truncatedCommand,
        expandedContent: hasOutput ? (
          <div className="space-y-2">
            <div className="whitespace-pre-wrap">{header}</div>
            <div>
              <div className="text-xs text-muted-foreground/60 mb-1">
                Output:
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs font-mono text-foreground/80 bg-muted/50 rounded p-2">
                {output}
              </pre>
            </div>
          </div>
        ) : (
          header
        ),
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

    case 'ReportFindings': {
      const findings = Array.isArray(input.findings) ? input.findings : []
      const count = findings.length
      return {
        icon: <ListTodo className="h-4 w-4 shrink-0" />,
        label: 'Report Findings',
        detail: `${count} finding${count === 1 ? '' : 's'}`,
        expandedContent:
          count > 0
            ? JSON.stringify(findings, null, 2)
            : 'No findings reported',
      }
    }

    case 'WebFetch':
    case 'WebSearch': {
      const url = input.url as string | undefined
      const query = input.query as string | undefined
      const prompt = input.prompt as string | undefined
      return {
        icon: <Globe className="h-4 w-4 shrink-0" />,
        label: normalized.name === 'WebSearch' ? 'Web Search' : 'Web Fetch',
        detail: url ?? query,
        expandedContent: url
          ? `URL: ${url}${prompt ? `\n\nPrompt: ${prompt}` : ''}`
          : `Query: ${query ?? '(none)'}`,
      }
    }

    // Codex multi-agent tools
    case 'SpawnAgent': {
      const prompt = input.prompt as string | undefined
      return {
        icon: <Users className="h-4 w-4 shrink-0" />,
        label: 'Spawn Agent',
        detail: codexSubagentDetail(input) ?? 'sub-agent',
        expandedContent:
          formatSubAgentActivity(input) ??
          prompt ??
          JSON.stringify(input, null, 2),
      }
    }

    case 'SendInput': {
      // Codex sub_agent_activity puts the agent path in `prompt`
      const detail = codexSubagentDetail(input)
      return {
        icon: <Send className="h-4 w-4 shrink-0" />,
        label: 'Send Input',
        detail: detail ? `to ${detail}` : undefined,
        expandedContent:
          formatSubAgentActivity(input) ?? JSON.stringify(input, null, 2),
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
        expandedContent: formatInputForExpanded(toolCall, input),
      }
    }

    case 'CloseAgent': {
      return {
        icon: <XCircle className="h-4 w-4 shrink-0" />,
        label: 'Close Agent',
        detail: codexSubagentDetail(input),
        expandedContent:
          formatSubAgentActivity(input) ?? JSON.stringify(input, null, 2),
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
            {todos.map(todo => {
              const text =
                todo.status === 'in_progress'
                  ? (todo.activeForm ?? todo.content ?? '')
                  : (todo.content ?? '')
              const done = todo.status === 'completed'
              const cancelled = todo.status === 'cancelled'
              const active = todo.status === 'in_progress'
              return (
                <div
                  key={`${todo.content}\0${todo.activeForm ?? ''}`}
                  className="flex items-center gap-1.5"
                >
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                  ) : cancelled ? (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
                  ) : active ? (
                    <WorkingWaveform className="w-3.5 justify-center" />
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
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
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
        icon: (
          <Wand2 className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
        ),
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
      const patchText = firstStringField(input, ['patchText', 'patch', 'input'])
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
        expandedContent: formatInputForExpanded(toolCall, input),
      }
    }

    case 'List':
    case 'list': {
      const path = input.path as string | undefined
      return {
        icon: <List className="h-4 w-4 shrink-0" />,
        label: 'List',
        detail: path,
        expandedContent: `Path: ${path ?? '(cwd)'}`,
      }
    }

    // OpenCode `lsp` (action) and Claude Code `LSP` (operation)
    case 'lsp':
    case 'LSP': {
      const action = firstStringField(input, ['operation', 'action', 'method'])
      const filePath = firstStringField(input, ['filePath', 'file_path'])
      const filename = filePath ? getFilename(filePath) : undefined
      return {
        icon: <Code className="h-4 w-4 shrink-0" />,
        label: 'LSP',
        detail: action
          ? `${action}${filename ? ` ${filename}` : ''}`
          : filename,
        filePath,
        expandedContent: formatInputForExpanded(toolCall, input),
      }
    }

    case 'MultiEdit': {
      const filePath = firstStringField(input, ['file_path', 'filePath'])
      const edits = (Array.isArray(input.edits) ? input.edits : []) as {
        old_string?: string
        new_string?: string
      }[]
      const count = `${edits.length} edit${edits.length === 1 ? '' : 's'}`
      return {
        icon: <Edit className="h-4 w-4 shrink-0" />,
        label: 'Multi Edit',
        detail: filePath ? `${getFilename(filePath)} · ${count}` : count,
        filePath,
        expandedContent:
          filePath && edits.length > 0 ? (
            <div className="space-y-2">
              {edits.map((edit, idx) => (
                <InlineFileDiff
                  // Edits have no stable id; order is fixed for a tool call.
                  key={`${idx}:${edit.old_string?.slice(0, 32) ?? ''}`}
                  filePath={filePath}
                  oldString={edit.old_string ?? ''}
                  newString={edit.new_string ?? ''}
                />
              ))}
            </div>
          ) : (
            formatInputForExpanded(toolCall, input)
          ),
      }
    }

    case 'NotebookEdit': {
      const notebookPath = firstStringField(input, ['notebook_path', 'path'])
      const editMode = firstStringField(input, ['edit_mode']) ?? 'replace'
      const cellId = firstStringField(input, ['cell_id'])
      const source =
        typeof input.new_source === 'string' ? input.new_source : ''
      const header = [
        notebookPath ? `Path: ${notebookPath}` : undefined,
        `Mode: ${editMode}`,
        cellId ? `Cell: ${cellId}` : undefined,
      ]
        .filter(Boolean)
        .join('\n')
      return {
        icon: <FileCode className="h-4 w-4 shrink-0" />,
        label: `Notebook ${editMode}`,
        detail: notebookPath
          ? `${getFilename(notebookPath)}${cellId ? ` · ${cellId}` : ''}`
          : cellId,
        filePath: notebookPath,
        expandedContent: source ? `${header}\n\n${source}` : header,
      }
    }

    case 'CodexWebSearch': {
      const detail = formatCodexWebSearchDetail(input)
      return {
        icon: <Globe className="h-4 w-4 shrink-0" />,
        label: 'Web Search',
        detail,
        expandedContent: formatCodexWebSearchExpanded(input, toolCall.output),
      }
    }

    case 'CodexImageGeneration': {
      const prompt =
        firstStringField(input, [
          'prompt',
          'revised_prompt',
          'revisedPrompt',
        ]) ?? undefined
      const savedPath = firstStringField(input, [
        'saved_path',
        'savedPath',
        'path',
      ])
      const status = firstStringField(input, ['status'])
      const detail = prompt ?? savedPath ?? status
      const parts: string[] = []
      if (prompt) parts.push(`Prompt: ${prompt}`)
      if (savedPath) parts.push(`Saved: ${savedPath}`)
      if (status) parts.push(`Status: ${status}`)
      if (
        toolCall.output &&
        !isPlaceholderToolOutput(toolCall.output) &&
        toolCall.output !== savedPath
      ) {
        parts.push(toolCall.output)
      }
      return {
        icon: <ImageIcon className="h-4 w-4 shrink-0" />,
        label: 'Image Generation',
        detail,
        expandedContent:
          parts.length > 0 ? parts.join('\n') : JSON.stringify(input, null, 2),
      }
    }

    case 'CodexImageView': {
      const path = firstStringField(input, ['path', 'file_path', 'filePath'])
      const filename = path ? getFilename(path) : undefined
      return {
        icon: <ImageIcon className="h-4 w-4 shrink-0" />,
        label: 'Image View',
        detail: filename ?? path,
        filePath: path,
        expandedContent:
          path ??
          (toolCall.output && !isPlaceholderToolOutput(toolCall.output)
            ? toolCall.output
            : JSON.stringify(input, null, 2)),
      }
    }

    case 'CodexContextCompaction': {
      const summary = firstStringField(input, ['summary'])
      return {
        icon: <Layers className="h-4 w-4 shrink-0" />,
        label: 'Context Compaction',
        detail: summary ? summary.slice(0, 60) : undefined,
        expandedContent:
          summary ??
          (toolCall.output && !isPlaceholderToolOutput(toolCall.output)
            ? toolCall.output
            : 'Context compacted'),
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
      const jeanBare = extractJeanMcpBareToolName(normalized.name)
      if (jeanBare) {
        return {
          icon: <Bot className="h-4 w-4 shrink-0" />,
          label: formatJeanMcpToolLabel(normalized.name),
          detail: formatJeanMcpToolDetail(input),
          expandedContent: formatInputForExpanded(toolCall, input),
        }
      }

      const spec = SIMPLE_TOOL_SPECS[normalized.name]
      if (spec) {
        const Icon = spec.icon
        return {
          icon: <Icon className="h-4 w-4 shrink-0" />,
          label: spec.label,
          detail: getSimpleToolDetail(spec, input),
          expandedContent: formatInputForExpanded(toolCall, input),
        }
      }

      const isKnownExternal = isRecognizedExternalTool(normalized.name)
      // Surface something useful even for tools without a dedicated renderer.
      const detail =
        firstStringField(input, [
          'query',
          'Query',
          'command',
          'CommandLine',
          'path',
          'AbsolutePath',
          'TargetFile',
          'DirectoryPath',
          'file_path',
          'filePath',
          'url',
          'Url',
          'pattern',
          'description',
          'Description',
          'prompt',
          'title',
          'name',
          'tool_name',
          'toolName',
          'backend',
          'projectId',
          'worktreeId',
        ]) ?? formatJeanMcpToolDetail(input)
      const expanded = formatInputForExpanded(toolCall, input)
      return {
        icon: <Terminal className="h-4 w-4 shrink-0" />,
        label: isKnownExternal
          ? isAntigravityNativeToolName(normalized.name) ||
            isMuseNativeToolName(normalized.name)
            ? humanizeSnakeCase(normalized.name)
            : normalized.name
          : `${normalized.name} (unhandled tool)`,
        detail,
        expandedContent: expanded,
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
      ? 'text-success'
      : status === 'error' || status === 'timeout'
        ? 'text-destructive'
        : 'text-warning'
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
          {isActive ? <WorkingWaveform /> : null}
        </div>
        {events.length === 0 ? (
          <div className="mt-1 text-[11px] italic text-muted-foreground">
            {status === 'armed' ? 'Waiting for events…' : 'No events emitted.'}
          </div>
        ) : (
          <div className="mt-1 max-h-64 divide-y divide-border/30 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
            {events.map(ev => {
              const text = formatMonitorEventText(ev)
              return (
                <div
                  key={`${ev.kind}:${ev.ts_ms}:${text}`}
                  className="py-1 first:pt-0 last:pb-0"
                >
                  <span
                    className={cn(
                      'whitespace-pre-wrap break-all',
                      ev.kind === 'monitor_status' && 'text-warning',
                      ev.kind === 'monitor_done' && 'text-success'
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
