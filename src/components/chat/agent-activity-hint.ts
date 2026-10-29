import type { ContentBlock, ToolCall } from '@/types/chat'
import { isAskUserQuestion, isPlanToolCall } from '@/types/chat'
import {
  normalizeToolCallForDisplay,
  summarizeToolCall,
} from './ToolCallInline'

const MAX_HINT_WORDS = 5

/** Keeps a hint to a few words so it reads at a glance. */
function shortHint(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  return words.length > MAX_HINT_WORDS
    ? `${words.slice(0, MAX_HINT_WORDS).join(' ')}…`
    : words.join(' ')
}

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function fileName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Program (and subcommand) of a shell command: "git status", "bun run".
 * Skips leading `cd …` steps and `VAR=value` assignments.
 */
function commandName(command: string): string | undefined {
  const step = command
    .split(/&&|\|\||;|\|/)
    .map(part => part.trim())
    .find(part => part && !/^cd(\s|$)/.test(part))
  const words = (step ?? '').split(/\s+/).filter(w => !/^\w+=/.test(w))
  const program = words[0] && fileName(words[0])
  if (!program) return undefined
  const sub = words[1]
  return sub && /^[a-z][\w-]*$/.test(sub) ? `${program} ${sub}` : program
}

/** Short (at most 5 words) "what it does now" phrase for one tool call. */
export function describeToolCall(toolCall: ToolCall): string {
  const { name, input } = normalizeToolCallForDisplay(
    toolCall.name,
    (toolCall.input ?? {}) as Record<string, unknown>
  )

  // The agent's own one-line intent (Bash, Task, Agent tools) reads best.
  const description = stringField(input, 'description')
  if (description) return shortHint(description)

  const path =
    stringField(input, 'file_path') ??
    stringField(input, 'notebook_path') ??
    stringField(input, 'path')
  const url = stringField(input, 'url')

  switch (name) {
    case 'Read':
      return path ? `Reading ${fileName(path)}` : 'Reading files'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return path ? `Editing ${fileName(path)}` : 'Editing files'
    case 'Grep':
    case 'Glob':
      return 'Searching the code'
    case 'WebSearch':
    case 'CodexWebSearch':
      return 'Searching the web'
    case 'WebFetch':
      return url ? `Reading ${hostName(url)}` : 'Reading a web page'
    case 'Bash': {
      const command = stringField(input, 'command')
      const program = command && commandName(command)
      return program ? `Running ${program}` : 'Running a command'
    }
  }

  return shortHint(summarizeToolCall(toolCall).label)
}

/**
 * Hint for quiet (agent) chats: what the agent does right now, from the
 * latest streamed block. Returns undefined when the latest block is prose
 * (already shown as a bubble) or nothing has streamed yet.
 */
export function describeAgentActivity(
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[]
): string | undefined {
  const last = contentBlocks.at(-1)
  if (last?.type === 'thinking') return 'Thinking'
  if (last && last.type !== 'tool_use') return undefined
  const toolCall = last
    ? toolCalls.find(tc => tc.id === last.tool_call_id)
    : toolCalls.at(-1)
  // Questions and plans render as their own cards
  if (!toolCall || isAskUserQuestion(toolCall) || isPlanToolCall(toolCall)) {
    return undefined
  }
  return describeToolCall(toolCall)
}
