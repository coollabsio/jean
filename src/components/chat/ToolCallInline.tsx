import { useState, useMemo } from 'react'
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
} from 'lucide-react'
import { diffLines } from 'diff'
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
  const [isOpen, setIsOpen] = useState(false)
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
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 cursor-pointer select-none min-w-0">
          {icon}
          <span className="font-medium">{label}</span>
          {detail && filePath && onFileClick ? (
            <code
              role="button"
              tabIndex={0}
              onClick={handleFileClick}
              onKeyDown={e =>
                e.key === 'Enter' &&
                handleFileClick(e as unknown as React.MouseEvent)
              }
              className="inline-flex items-center gap-1 truncate rounded bg-muted/50 px-1.5 py-0.5 text-xs hover:bg-primary/20 hover:text-primary transition-colors cursor-pointer"
            >
              <span className="truncate">{detail}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </code>
          ) : detail ? (
            <code className="truncate rounded bg-muted/50 px-1.5 py-0.5 text-xs">
              {detail}
            </code>
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
            {toolCall.output && (
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
  const [isOpen, setIsOpen] = useState(false)
  const input = taskToolCall.input as Record<string, unknown>
  const subagentType = input.subagent_type as string | undefined
  const description = input.description as string | undefined
  const prompt = input.prompt as string | undefined

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
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 cursor-pointer select-none min-w-0">
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">
            {subagentType ? `Task (${subagentType})` : 'Task'}
          </span>
          {description && (
            <code className="truncate rounded bg-muted/50 px-1.5 py-0.5 text-xs">
              {description}
            </code>
          )}
          {/* Show sub-tool count badge */}
          {subToolCalls.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground/60">
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
                  subTool.name === 'Task' && allToolCalls ? (
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
  const [isOpen, setIsOpen] = useState(false)

  // Count thinking blocks and tools for summary
  let thinkingCount = 0
  const toolCounts = new Map<string, number>()
  for (const item of items) {
    if (item.type === 'thinking') {
      thinkingCount++
    } else {
      toolCounts.set(item.tool.name, (toolCounts.get(item.tool.name) ?? 0) + 1)
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
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 cursor-pointer select-none min-w-0">
          <Layers className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">{summary}</span>
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
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          'rounded border border-border/30 bg-background/50',
          isOpen && 'bg-muted/30'
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/80 hover:bg-muted/30 cursor-pointer select-none">
          <Brain className="h-3 w-3 shrink-0 text-purple-500" />
          <span className="font-medium">Thinking</span>
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
              <Markdown>{thinking}</Markdown>
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
  const [isOpen, setIsOpen] = useState(false)
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
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/80 hover:bg-muted/30 cursor-pointer select-none">
          <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
          <span className="font-medium">{label}</span>
          {detail && filePath && onFileClick ? (
            <code
              role="button"
              tabIndex={0}
              onClick={handleFileClick}
              onKeyDown={e =>
                e.key === 'Enter' &&
                handleFileClick(e as unknown as React.MouseEvent)
              }
              className="inline-flex items-center gap-0.5 truncate rounded bg-muted/30 px-1 py-0.5 text-[0.625rem] hover:bg-primary/20 hover:text-primary transition-colors cursor-pointer"
            >
              <span className="truncate">{detail}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </code>
          ) : detail ? (
            <code className="truncate rounded bg-muted/30 px-1 py-0.5 text-[0.625rem]">
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
            {toolCall.output && (
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
  detail?: string
  /** Full file path for file-related tools (Read, Edit, Write) */
  filePath?: string
  expandedContent: React.ReactNode
}

/** Renders a unified diff view with colored +/- lines */
function DiffView({
  oldString,
  newString,
  filePath,
  className,
}: {
  oldString: string
  newString: string
  filePath: string
  className?: string
}) {
  const parts = useMemo(
    () => diffLines(oldString, newString),
    [oldString, newString]
  )

  return (
    <div className={className}>
      <div className="text-muted-foreground mb-1.5 font-mono">Path: {filePath}</div>
      <div className="rounded border border-border/30 overflow-auto max-h-64">
        {parts.map((part, i) => {
          const lines = part.value.replace(/\n$/, '').split('\n')
          return lines.map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={cn(
                'px-2 font-mono',
                part.added && 'bg-green-500/15 text-green-400',
                part.removed && 'bg-red-500/15 text-red-400'
              )}
            >
              <span className="inline-block w-4 select-none opacity-60">
                {part.added ? '+' : part.removed ? '-' : ' '}
              </span>
              {line}
            </div>
          ))
        })}
      </div>
    </div>
  )
}

function getToolDisplay(toolCall: ToolCall): ToolDisplay {
  const input = toolCall.input as Record<string, unknown>

  switch (toolCall.name) {
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
          <DiffView
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
      const receiverIds = input.receiver_thread_ids as string[] | undefined
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
      const changes = input as Record<string, unknown>
      const filePath = (changes.file ?? changes.path ?? changes.file_path) as
        | string
        | undefined
      const filename = filePath ? getFilename(filePath) : undefined

      // If input is an array of changes, summarize
      const isArray = Array.isArray(toolCall.input)
      const fileCount = isArray ? (toolCall.input as unknown[]).length : undefined
      const detail = isArray
        ? `${fileCount} file${fileCount === 1 ? '' : 's'}`
        : filename

      return {
        icon: <FileText className="h-4 w-4 shrink-0" />,
        label: 'File Change',
        detail,
        filePath,
        expandedContent: JSON.stringify(toolCall.input, null, 2),
      }
    }

    case 'EnterPlanMode': {
      return {
        icon: <Brain className="h-4 w-4 shrink-0" />,
        label: 'Entered plan mode',
        detail: undefined,
        expandedContent: 'Switched to plan mode',
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

    default: {
      const isMcpTool = toolCall.name.startsWith('mcp__')
      return {
        icon: <Terminal className="h-4 w-4 shrink-0" />,
        label: isMcpTool ? toolCall.name : `${toolCall.name} (unhandled tool)`,
        detail: undefined,
        expandedContent: JSON.stringify(input, null, 2),
      }
    }
  }
}
