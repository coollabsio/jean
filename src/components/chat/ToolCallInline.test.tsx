import { fireEvent, render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeToolCallForDisplay,
  TaskCallInline,
  ToolCallInline,
} from './ToolCallInline'
import type { ComponentProps } from 'react'
import type * as InlineFileDiffModule from './InlineFileDiff'

const inlineFileDiffProps = vi.hoisted(() => [] as Record<string, unknown>[])
type InlineFileDiffProps = ComponentProps<
  typeof InlineFileDiffModule.InlineFileDiff
>

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

vi.mock('./InlineFileDiff', async importOriginal => {
  const actual = (await importOriginal()) as typeof InlineFileDiffModule

  return {
    ...actual,
    InlineFileDiff: (props: InlineFileDiffProps) => {
      inlineFileDiffProps.push(props as unknown as Record<string, unknown>)
      return actual.InlineFileDiff(props)
    },
  }
})

describe('ToolCallInline', () => {
  it('renders Cursor EnterPlanMode instructions', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-enter-plan-1',
          name: 'EnterPlanMode',
          input: {
            title: 'Plan mode instructions',
            instructions: [
              'Read/analyze only; do not write, edit, or create files.',
              'Do not run mutating commands.',
            ],
          },
        }}
      />
    )

    expect(screen.getByText('Entered plan mode')).toBeInTheDocument()
    expect(
      screen.getByText('Read-only analysis instructions')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Plan mode instructions:')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Read/analyze only; do not write, edit, or create files.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('Do not run mutating commands.')
    ).toBeInTheDocument()
  })

  it('renders OpenCode ToolSearch calls without the unhandled fallback', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-1',
          name: 'ToolSearch',
          input: {
            query: 'selectExitPlanMode',
            max_results: 1,
          },
        }}
      />
    )

    expect(screen.getByText('Tool Search')).toBeInTheDocument()
    expect(screen.getByText('selectExitPlanMode')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    const expandedContent = screen.getByText((_, element) =>
      Boolean(
        element?.classList.contains('whitespace-pre-wrap') &&
        element.textContent === 'Query: selectExitPlanMode\nMax results: 1'
      )
    )

    expect(expandedContent).toBeInTheDocument()
  })

  it('renders Command Code read_file calls as file reads', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-commandcode-read-1',
          name: 'read_file',
          input: {
            absolutePath: '/Users/example/project/package.json',
            limit: 20,
          },
        }}
      />
    )

    expect(screen.getByText('Read 20 lines')).toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.classList.contains('whitespace-pre-wrap') &&
          element.textContent ===
            'Path: /Users/example/project/package.json\nLimit: 20'
        )
      )
    ).toBeInTheDocument()
  })

  it('renders Command Code shell_command calls as Bash', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-commandcode-shell-1',
          name: 'shell_command',
          input: {
            command: 'date',
          },
        }}
      />
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('date')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
  })

  it('renders additional Command Code snake_case tools without the unhandled fallback', () => {
    const tools = [
      {
        id: 'tool-write',
        name: 'write_file',
        input: {
          filePath: '/Users/example/project/.ai/demo.md',
          content: '# Demo',
        },
        label: 'Write',
        detail: 'demo.md',
      },
      {
        id: 'tool-glob',
        name: 'glob',
        input: { pattern: '*.md' },
        label: 'Glob',
        detail: '*.md',
      },
      {
        id: 'tool-grep',
        name: 'grep',
        input: { pattern: 'version', include: ['package.json'] },
        label: 'Grep',
        detail: '"version"',
      },
      {
        id: 'tool-list',
        name: 'read_directory',
        input: { path: '/Users/example/project/.ai' },
        label: 'List',
        detail: '/Users/example/project/.ai',
      },
      {
        id: 'tool-multi-read',
        name: 'read_multiple_files',
        input: {
          targetDirectory: '/Users/example/project/.ai',
          include: ['*.md'],
        },
        label: 'Read Multiple Files',
        detail: '*.md in /Users/example/project/.ai',
      },
    ]

    for (const tool of tools) {
      const { unmount } = render(
        <ToolCallInline
          toolCall={{
            id: tool.id,
            name: tool.name,
            input: tool.input,
          }}
        />
      )

      expect(screen.getByText(tool.label)).toBeInTheDocument()
      expect(screen.getByText(tool.detail)).toBeInTheDocument()
      expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
      unmount()
    }
  })

  it('renders FileChange diffs without duplicate raw output', () => {
    const { container } = render(
      <ToolCallInline
        toolCall={{
          id: 'tool-file-change-1',
          name: 'FileChange',
          input: [
            {
              path: '/tmp/chat-store.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
          output:
            '[{"diff":"@@ -1 +1 @@\\n-old\\n+new","kind":{"type":"update","move_path":null},"path":"/tmp/chat-store.ts"}]',
        }}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('chat-store.ts')).toBeInTheDocument()
    expect(screen.getByText('update')).toBeInTheDocument()
    expect(inlineFileDiffProps.at(-1)).toMatchObject({
      patch: '@@ -1 +1 @@\n-old\n+new',
      filePath: '/tmp/chat-store.ts',
    })
    expect(inlineFileDiffProps.at(-1)).not.toHaveProperty('neutral')
    // <FileDiff> renders its diff inside a <diffs-container> custom element
    expect(container.querySelector('diffs-container')).not.toBeNull()
    expect(screen.queryByText('Output:')).not.toBeInTheDocument()
  })

  it('falls back to parsing legacy FileChange output when input is empty', () => {
    const { container } = render(
      <ToolCallInline
        toolCall={{
          id: 'tool-file-change-2',
          name: 'FileChange',
          input: null,
          output:
            '[{"diff":"@@ -2 +2 @@\\n-before\\n+after","kind":{"type":"update","move_path":null},"path":"/tmp/legacy.ts"}]',
        }}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getAllByText('legacy.ts')).toHaveLength(2)
    expect(container.querySelector('diffs-container')).not.toBeNull()
    expect(screen.queryByText('Output:')).not.toBeInTheDocument()
  })
})

describe('normalizeToolCallForDisplay', () => {
  it('normalizes persisted Grok ACP tool variants for the existing renderers', () => {
    expect(
      normalizeToolCallForDisplay('search', {
        variant: 'Grep',
        pattern: 'needle',
        path: '/tmp',
      })
    ).toMatchObject({
      name: 'Grep',
      input: { pattern: 'needle', path: '/tmp' },
    })

    expect(
      normalizeToolCallForDisplay('read', {
        variant: 'CursorRead',
        path: '/tmp/a.rs',
      })
    ).toMatchObject({
      name: 'Read',
      input: { file_path: '/tmp/a.rs' },
    })

    expect(
      normalizeToolCallForDisplay('edit', {
        variant: 'CursorWrite',
        path: '/tmp/a.rs',
        contents: 'hello',
      })
    ).toMatchObject({
      name: 'Write',
      input: { file_path: '/tmp/a.rs', content: 'hello' },
    })

    expect(
      normalizeToolCallForDisplay('other', {
        variant: 'TaskOutput',
        task_ids: ['task-1', 'task-2'],
      })
    ).toMatchObject({
      name: 'WaitForAgents',
      input: { receiver_thread_ids: ['task-1', 'task-2'] },
    })
  })

  it('renders a raw Grok grep update instead of the JSON fallback', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'grok-grep-1',
          name: 'search',
          input: {
            variant: 'Grep',
            pattern: 'needle',
            path: '/tmp',
          },
        }}
      />
    )

    expect(screen.getByText('Grep')).toBeInTheDocument()
    expect(screen.getByText('"needle" in /tmp')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
  })
})

describe('TaskCallInline', () => {
  it('shows the subagent final report when expanded', () => {
    render(
      <TaskCallInline
        taskToolCall={{
          id: 'task-1',
          name: 'Task',
          input: {
            description: 'Explore auth',
            prompt: 'Find how auth works',
            subagent_type: 'Explore',
          },
          output:
            'Findings: auth uses JWT middleware.\n\nEntry point is `src/auth.rs`.',
        }}
        subToolCalls={[
          {
            id: 'sub-read-1',
            name: 'Read',
            input: { file_path: 'src/auth.rs' },
            parent_tool_use_id: 'task-1',
          },
        ]}
      />
    )

    expect(screen.getByText('Task (Explore)')).toBeInTheDocument()
    expect(screen.getByText('Explore auth')).toBeInTheDocument()
    expect(screen.queryByText('Report:')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Report:')).toBeInTheDocument()
    expect(
      screen.getByText(/Findings: auth uses JWT middleware/)
    ).toBeInTheDocument()
    expect(screen.getByText(/Find how auth works/)).toBeInTheDocument()
  })

  it('does not render a Report section when output is empty', () => {
    render(
      <TaskCallInline
        taskToolCall={{
          id: 'task-empty',
          name: 'Task',
          input: {
            description: 'Still running',
            prompt: 'Do research',
          },
          output: '   ',
        }}
        subToolCalls={[]}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Do research')).toBeInTheDocument()
    expect(screen.queryByText('Report:')).not.toBeInTheDocument()
  })

  it('labels Agent tool calls as Agent and nests them', () => {
    render(
      <TaskCallInline
        taskToolCall={{
          id: 'agent-1',
          name: 'Agent',
          input: {
            description: 'Nested agent',
            prompt: 'Delegate work',
            subagent_type: 'general-purpose',
          },
          output: 'Nested agent finished.',
        }}
        subToolCalls={[
          {
            id: 'agent-nested',
            name: 'Agent',
            input: {
              description: 'Child agent',
              prompt: 'Child work',
            },
            parent_tool_use_id: 'agent-1',
          },
        ]}
        allToolCalls={[
          {
            id: 'agent-nested',
            name: 'Agent',
            input: {
              description: 'Child agent',
              prompt: 'Child work',
            },
            parent_tool_use_id: 'agent-1',
          },
        ]}
      />
    )

    expect(screen.getByText('Agent (general-purpose)')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Agent (general-purpose)'))

    expect(screen.getByText('Report:')).toBeInTheDocument()
    expect(screen.getByText('Nested agent finished.')).toBeInTheDocument()
    // Nested Agent renders as another TaskCallInline row, not a SubToolItem
    expect(screen.getByText('Child agent')).toBeInTheDocument()
  })
})
