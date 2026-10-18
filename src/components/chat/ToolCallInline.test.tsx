import { fireEvent, render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import {
  extractJeanMcpBareToolName,
  formatJeanMcpToolLabel,
  isJeanMcpToolName,
  normalizeToolCallForDisplay,
  StackedGroup,
  summarizeToolCall,
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

function clickExpandTrigger() {
  const triggers = document.querySelectorAll(
    '[data-slot="collapsible-trigger"]'
  )
  const trigger = triggers[0]
  if (!trigger) throw new Error('No collapsible trigger found')
  fireEvent.click(trigger)
}

describe('ToolCallInline', () => {
  it('keeps a tool open when streaming content is replaced by persisted content', () => {
    const toolCall = {
      id: 'tool-remount-open-state',
      name: 'Read',
      input: { file_path: '/tmp/remount.ts' },
    }
    const firstRender = render(<ToolCallInline toolCall={toolCall} />)

    fireEvent.click(screen.getByText('remount.ts'))
    expect(screen.getByText('Path: /tmp/remount.ts')).toBeInTheDocument()

    firstRender.unmount()
    render(<ToolCallInline toolCall={toolCall} />)

    expect(screen.getByText('Path: /tmp/remount.ts')).toBeInTheDocument()
  })

  it('keeps clickable file details at the compact tool-row font size', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-read-font-size',
          name: 'Read',
          input: { file_path: '/tmp/example.ts', limit: 20 },
        }}
        onFileClick={vi.fn()}
      />
    )

    const fileDetail = screen.getByText('example.ts')
    expect(fileDetail.tagName).toBe('CODE')
    expect(fileDetail).not.toHaveClass('font-mono')
    expect(fileDetail).toHaveClass('font-sans')
  })

  it('expands when the command detail is clicked and does not expose selectable text', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-bash-click-row',
          name: 'Bash',
          input: {
            command: 'php artisan test --compact tests/Unit/DockerStopCo',
          },
        }}
      />
    )

    const command = screen.getByText(
      'php artisan test --compact tests/Unit/DockerStopCo'
    )
    expect(command.closest('.tool-call-row')).toHaveClass('select-none')
    expect(
      screen.queryByText('$ php artisan test --compact tests/Unit/DockerStopCo')
    ).not.toBeInTheDocument()

    fireEvent.click(command)

    expect(
      screen.getByText('$ php artisan test --compact tests/Unit/DockerStopCo')
    ).toBeInTheDocument()
  })

  it('opens the file from the icon without expanding the row', () => {
    const onFileClick = vi.fn()
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-read-open-icon',
          name: 'Read',
          input: { file_path: '/tmp/example.ts' },
        }}
        onFileClick={onFileClick}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /open example\.ts/i }))

    expect(onFileClick).toHaveBeenCalledWith('/tmp/example.ts')
    expect(screen.queryByText('Path: /tmp/example.ts')).not.toBeInTheDocument()
  })

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

    clickExpandTrigger()

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

    clickExpandTrigger()

    const expandedContent = screen.getByText((_, element) =>
      Boolean(
        element?.classList.contains('whitespace-pre-wrap') &&
        element.textContent === 'Query: selectExitPlanMode\nMax results: 1'
      )
    )

    expect(expandedContent).toBeInTheDocument()
  })

  it('renders Claude code-review findings without the unhandled fallback', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-report-findings-1',
          name: 'ReportFindings',
          input: {
            findings: [
              {
                file: 'src/example.ts',
                line: 42,
                category: 'correctness',
                summary: 'The request can fail silently.',
              },
              {
                file: 'src/other.ts',
                line: 10,
                category: 'testing',
                summary: 'The failure path has no test.',
              },
            ],
          },
        }}
      />
    )

    expect(screen.getByText('Report Findings')).toBeInTheDocument()
    expect(screen.getByText('2 findings')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()

    clickExpandTrigger()

    expect(
      screen.getByText(/The request can fail silently/)
    ).toBeInTheDocument()
    expect(screen.getByText(/The failure path has no test/)).toBeInTheDocument()
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

    clickExpandTrigger()

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

  it('renders bash/shell stdout in the expanded tool body (issue #572)', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-bash-with-output',
          name: 'Bash',
          input: { command: 'cd /tmp; ls -la' },
          output:
            'exit: 0\ntotal 8\ndrwxr-xr-x 2 root root 4096 Jul 1 12:00 .\n',
        }}
      />
    )

    // Collapsed row still shows the command
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('cd /tmp; ls -la')).toBeInTheDocument()

    clickExpandTrigger()

    // Expanded body must surface the actual command return, not only `$ command`
    expect(screen.getByText('Output:')).toBeInTheDocument()
    expect(screen.getByText(/total 8/)).toBeInTheDocument()
    expect(screen.getByText(/\$ cd \/tmp; ls -la/)).toBeInTheDocument()
  })

  it('renders shell_command stdout the same way as Bash', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-commandcode-shell-success',
          name: 'shell_command',
          input: { command: 'deploy' },
          output: 'deployed revision abc123\n',
        }}
      />
    )

    clickExpandTrigger()

    expect(screen.getByText('Output:')).toBeInTheDocument()
    expect(screen.getByText(/deployed revision abc123/)).toBeInTheDocument()
  })

  it.each([
    'Bash',
    'shell_command',
    'run_terminal_command',
    'Shell',
    'shell',
    'execute',
  ])('renders %s without a variant through the Bash renderer', name => {
    const output = `stdout from ${name}`
    const { unmount } = render(
      <ToolCallInline
        toolCall={{
          id: `tool-${name}`,
          name,
          input: { command: 'printf hello' },
          output,
        }}
      />
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('printf hello')).toBeInTheDocument()

    clickExpandTrigger()

    expect(screen.getByText(output)).toBeInTheDocument()
    expect(screen.getAllByText('Output:')).toHaveLength(1)
    unmount()
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

  it.each([
    ['run_command', { CommandLine: 'bun test' }, 'Bash', 'bun test'],
    [
      'view_file',
      { AbsolutePath: '/Users/example/project/src/app.ts' },
      'Read',
      'app.ts',
    ],
    [
      'write_to_file',
      {
        TargetFile: '/Users/example/project/src/new.ts',
        CodeContent: 'export {}',
      },
      'Write',
      'new.ts',
    ],
    [
      'replace_file_content',
      {
        TargetFile: '/Users/example/project/src/app.ts',
        TargetContent: 'old',
        ReplacementContent: 'new',
      },
      'Edit',
      'app.ts',
    ],
    [
      'grep_search',
      { Query: 'Antigravity', SearchPath: '/Users/example/project' },
      'Grep',
      '"Antigravity" in /Users/example/project',
    ],
    [
      'find_by_name',
      { Pattern: '*.rs', SearchDirectory: '/Users/example/project' },
      'Glob',
      '*.rs',
    ],
    [
      'list_dir',
      { DirectoryPath: '/Users/example/project/src' },
      'List',
      '/Users/example/project/src',
    ],
    [
      'search_web',
      { Query: 'Antigravity CLI docs' },
      'Web Search',
      'Antigravity CLI docs',
    ],
    [
      'read_url_content',
      { Url: 'https://antigravity.google' },
      'Web Fetch',
      'https://antigravity.google',
    ],
  ])(
    'renders Antigravity %s with the common renderer',
    (name, input, label, detail) => {
      render(
        <ToolCallInline toolCall={{ id: `antigravity-${name}`, name, input }} />
      )

      expect(screen.getByText(label)).toBeInTheDocument()
      expect(screen.getByText(detail)).toBeInTheDocument()
      expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
    }
  )

  it.each([
    'browser_click',
    'browser_get_dom',
    'command_status',
    'generate_image',
    'list_browser_pages',
    'manage_inbox',
    'manage_subagents',
    'manage_task',
    'notify_user',
    'open_browser_url',
    'read_browser_page',
    'read_knowledge_base_item',
    'read_terminal',
    'search_knowledge_base',
    'send_command_input',
    'task_boundary',
  ])(
    'recognizes native Antigravity tool %s without an unhandled warning',
    name => {
      render(
        <ToolCallInline
          toolCall={{
            id: `antigravity-${name}`,
            name,
            input: { Description: 'Native Antigravity operation' },
          }}
        />
      )

      expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
    }
  )

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

    clickExpandTrigger()

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

    clickExpandTrigger()

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

  it('renders CodexWebSearch with query detail instead of blank completed', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'ws-1',
          name: 'CodexWebSearch',
          input: {
            query: 'tauri v2 plugins',
            results: [{ title: 'Tauri docs', url: 'https://v2.tauri.app' }],
          },
          output: 'completed',
        }}
      />
    )

    expect(screen.getByText('Web Search')).toBeInTheDocument()
    expect(screen.getByText('tauri v2 plugins')).toBeInTheDocument()

    clickExpandTrigger()

    expect(screen.getByText(/Query: tauri v2 plugins/)).toBeInTheDocument()
    expect(screen.getByText(/Tauri docs/)).toBeInTheDocument()
    // Placeholder "completed" must not appear as useful content
    expect(screen.queryByText(/^completed$/)).not.toBeInTheDocument()
    expect(screen.queryByText('Output:')).not.toBeInTheDocument()
  })

  it('renders CodexWebSearch openPage action url as detail', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'ws-2',
          name: 'CodexWebSearch',
          input: {
            query: '',
            action: { type: 'openPage', url: 'https://example.com/docs' },
          },
        }}
      />
    )

    expect(screen.getByText('Web Search')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/docs')).toBeInTheDocument()
  })

  it('renders CodexImageView path instead of blank completed', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'img-1',
          name: 'CodexImageView',
          input: { path: '/tmp/screenshots/ui.png' },
          output: 'completed',
        }}
      />
    )

    expect(screen.getByText('Image View')).toBeInTheDocument()
    expect(screen.getByText('ui.png')).toBeInTheDocument()

    clickExpandTrigger()

    expect(screen.getByText('/tmp/screenshots/ui.png')).toBeInTheDocument()
    expect(screen.queryByText(/^completed$/)).not.toBeInTheDocument()
  })

  it('surfaces a detail field for unhandled tools when available', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'dyn-1',
          name: 'DynamicToolCall:lookup',
          input: { query: 'session recovery' },
          output: 'completed',
        }}
      />
    )

    expect(
      screen.getByText('DynamicToolCall:lookup (unhandled tool)')
    ).toBeInTheDocument()
    expect(screen.getByText('session recovery')).toBeInTheDocument()
  })

  it('renders Jean MCP tools via use_tool wrapper without unhandled fallback', () => {
    // Matches issue #573 screenshot: use_tool({ tool_name, tool_input })
    const cases = [
      {
        id: 'jean-ctx',
        tool_name: 'jean_get_current_context',
        tool_input: {},
        label: 'Jean: Get Current Context',
      },
      {
        id: 'jean-projects',
        tool_name: 'jean_list_projects',
        tool_input: {},
        label: 'Jean: List Projects',
      },
      {
        id: 'jean-worktrees',
        tool_name: 'jean_list_worktrees',
        tool_input: { projectId: 'b11f5add-ad7a-487c-b236-356ca6b4f18e' },
        label: 'Jean: List Worktrees',
        detail: 'project b11f5add',
      },
      {
        id: 'jean-session',
        tool_name: 'jean_create_session',
        tool_input: {
          backend: 'codex',
          name: 'pg-moderation-verify',
          worktreeId: '77a6074b-8035-4bdc-a477-06653f5af4d8',
        },
        label: 'Jean: Create Session',
        detail: 'codex · pg-moderation-verify',
      },
    ]

    for (const tc of cases) {
      const { unmount } = render(
        <ToolCallInline
          toolCall={{
            id: tc.id,
            name: 'use_tool',
            input: {
              tool_name: tc.tool_name,
              tool_input: tc.tool_input,
            },
          }}
        />
      )

      expect(screen.getByText(tc.label)).toBeInTheDocument()
      expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/^use_tool$/)).not.toBeInTheDocument()
      if (tc.detail) {
        expect(screen.getByText(tc.detail)).toBeInTheDocument()
      }
      unmount()
    }
  })

  it('renders prefixed Jean tools without unhandled fallback', () => {
    const names = [
      'mcp:jean:list_worktrees',
      'mcp__jean__create_session',
      'mcp__jean-dev__get_current_context',
      'jean_list_sessions',
    ]

    for (const name of names) {
      const { unmount } = render(
        <ToolCallInline
          toolCall={{
            id: `tool-${name}`,
            name,
            input: {},
          }}
        />
      )

      expect(screen.getByText(/^Jean:/)).toBeInTheDocument()
      expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()
      unmount()
    }
  })

  it('still labels true unknowns as unhandled', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'mystery-1',
          name: 'SomeFutureTool',
          input: { foo: 'bar' },
        }}
      />
    )

    expect(
      screen.getByText('SomeFutureTool (unhandled tool)')
    ).toBeInTheDocument()
  })
})

describe('Jean MCP tool helpers', () => {
  it('extracts bare names from prefixed forms', () => {
    expect(extractJeanMcpBareToolName('jean_get_current_context')).toBe(
      'get_current_context'
    )
    expect(extractJeanMcpBareToolName('jean-dev_list_projects')).toBe(
      'list_projects'
    )
    expect(extractJeanMcpBareToolName('mcp:jean:list_worktrees')).toBe(
      'list_worktrees'
    )
    expect(extractJeanMcpBareToolName('mcp__jean__create_session')).toBe(
      'create_session'
    )
    expect(
      extractJeanMcpBareToolName('mcp__jean-dev__get_current_context')
    ).toBe('get_current_context')
    expect(extractJeanMcpBareToolName('get_current_context')).toBeNull()
    expect(extractJeanMcpBareToolName('Bash')).toBeNull()
    expect(extractJeanMcpBareToolName('mcp__github__search')).toBeNull()
  })

  it('formats friendly Jean labels', () => {
    expect(formatJeanMcpToolLabel('jean_get_current_context')).toBe(
      'Jean: Get Current Context'
    )
    expect(formatJeanMcpToolLabel('mcp:jean:create_session')).toBe(
      'Jean: Create Session'
    )
    expect(isJeanMcpToolName('jean_list_projects')).toBe(true)
    expect(isJeanMcpToolName('Read')).toBe(false)
  })

  it('unwraps use_tool in normalizeToolCallForDisplay', () => {
    expect(
      normalizeToolCallForDisplay('use_tool', {
        tool_name: 'jean_create_session',
        tool_input: {
          backend: 'codex',
          worktreeId: 'wt-1',
        },
      })
    ).toMatchObject({
      name: 'jean_create_session',
      input: { backend: 'codex', worktreeId: 'wt-1' },
    })

    expect(
      normalizeToolCallForDisplay('useTool', {
        toolName: 'list_projects',
        toolInput: {},
      })
    ).toMatchObject({
      name: 'list_projects',
      input: {},
    })
  })
})

describe('StackedGroup', () => {
  it('keeps a group open when streaming content is replaced by persisted content', () => {
    const items = [
      {
        type: 'tool' as const,
        tool: {
          id: 'stacked-remount-open-state',
          name: 'Read',
          input: { file_path: '/tmp/group-remount.ts' },
        },
      },
    ]
    const firstRender = render(<StackedGroup items={items} />)

    fireEvent.click(screen.getByText('1 Read'))
    expect(screen.getByText('group-remount.ts')).toBeInTheDocument()

    firstRender.unmount()
    render(<StackedGroup items={items} />)

    expect(screen.getByText('group-remount.ts')).toBeInTheDocument()
  })

  it('keeps nested Read file details at the same compact size as Grep/Bash', () => {
    render(
      <StackedGroup
        items={[
          {
            type: 'tool',
            tool: {
              id: 'stacked-read-1',
              name: 'Read',
              input: { file_path: '/tmp/example.ts', limit: 20 },
            },
          },
          {
            type: 'tool',
            tool: {
              id: 'stacked-grep-1',
              name: 'Grep',
              input: { pattern: 'StopApplication' },
            },
          },
        ]}
        onFileClick={vi.fn()}
      />
    )

    clickExpandTrigger()

    const fileDetail = screen.getByText('example.ts')
    const grepDetail = screen.getByText('"StopApplication"')
    expect(fileDetail.tagName).toBe('CODE')
    expect(fileDetail).not.toHaveClass('font-mono')
    expect(fileDetail).toHaveClass('font-sans')
    expect(grepDetail).toHaveClass('font-sans')
    expect(fileDetail.className).toContain('text-[0.625rem]')
    expect(grepDetail.className).toContain('text-[0.625rem]')
    expect(fileDetail.closest('.tool-call-row')).toHaveClass('select-none')
  })

  it('uses the wrapped Jean tool name in its summary', () => {
    render(
      <StackedGroup
        items={[
          {
            type: 'tool',
            tool: {
              id: 'wrapped-jean-1',
              name: 'use_tool',
              input: {
                tool_name: 'jean_list_projects',
                tool_input: {},
              },
            },
          },
        ]}
      />
    )

    expect(screen.getByText('1 Jean: List Projects')).toBeInTheDocument()
    expect(screen.queryByText('1 use_tool')).not.toBeInTheDocument()
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

    clickExpandTrigger()

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

    clickExpandTrigger()

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

describe('tool output rendering', () => {
  it('does not render a raw Output panel for Read (live and history match)', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'read-with-output',
          name: 'Read',
          input: { file_path: '/tmp/big.ts' },
          output: 'export const huge = 1',
        }}
      />
    )
    clickExpandTrigger()
    expect(screen.getByText('Path: /tmp/big.ts')).toBeInTheDocument()
    expect(screen.queryByText('Output:')).not.toBeInTheDocument()
    expect(screen.queryByText('export const huge = 1')).not.toBeInTheDocument()
  })

  it.each([
    ['mcp__github__get_issue', { issue: 1 }],
    ['mcp__jean__list_projects', {}],
    ['SomeFutureTool', { foo: 'bar' }],
    ['CodeSearch', { query: 'needle' }],
    ['List', { path: '/tmp' }],
    ['WaitForAgents', { receiver_thread_ids: ['a'] }],
    ['lsp', { action: 'hover', filePath: '/tmp/a.ts' }],
  ])('renders %s output exactly once', (name, input) => {
    render(
      <ToolCallInline
        toolCall={{ id: `once-${name}`, name, input, output: 'RESULT-TEXT' }}
      />
    )
    clickExpandTrigger()
    expect(screen.getAllByText('RESULT-TEXT')).toHaveLength(1)
    expect(screen.getByText('Output:')).toBeInTheDocument()
  })
})

describe('Claude Code tool renderers', () => {
  it.each([
    ['BashOutput', { bash_id: 'shell-1' }, 'Bash Output', 'shell-1'],
    ['TaskOutput', { task_id: 'task-9', block: true }, 'Task Output', 'task-9'],
    ['KillShell', { shell_id: 'shell-2' }, 'Kill Shell', 'shell-2'],
    ['KillBash', { shell_id: 'shell-3' }, 'Kill Shell', 'shell-3'],
    ['TaskStop', { task_id: 'task-4' }, 'Stop Task', 'task-4'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'PowerShell', 'Get-ChildItem'],
    [
      'LSP',
      { operation: 'goToDefinition', filePath: '/src/a.ts', line: 1 },
      'LSP',
      'goToDefinition a.ts',
    ],
    [
      'SendMessage',
      { to: 'researcher', message: 'hi' },
      'Send Message',
      'researcher',
    ],
    ['EnterWorktree', { name: 'feat-x' }, 'Enter Worktree', 'feat-x'],
    ['ExitWorktree', { action: 'keep' }, 'Exit Worktree', 'keep'],
    [
      'CronCreate',
      { cron: '*/5 * * * *', prompt: 'p' },
      'Schedule Prompt',
      '*/5 * * * *',
    ],
    ['CronDelete', { id: 'job-1' }, 'Delete Schedule', 'job-1'],
    [
      'ReadMcpResourceTool',
      { server: 's', uri: 'file://x' },
      'Read MCP Resource',
      'file://x',
    ],
    [
      'ListMcpResourcesTool',
      { server: 'github' },
      'List MCP Resources',
      'github',
    ],
    ['TaskCreate', { subject: 'Write tests' }, 'Create Task', 'Write tests'],
    [
      'TaskUpdate',
      { taskId: '3', status: 'completed' },
      'Update Task',
      'completed',
    ],
    ['TaskGet', { taskId: '3' }, 'Get Task', '3'],
    ['Workflow', { description: 'Refactor all' }, 'Workflow', 'Refactor all'],
    [
      'PushNotification',
      { message: 'build done' },
      'Push Notification',
      'build done',
    ],
    [
      'WaitForMcpServers',
      { servers: ['github', 'linear'] },
      'Wait for MCP Servers',
      'github, linear',
    ],
  ])('renders %s with a label and detail', (name, input, label, detail) => {
    render(<ToolCallInline toolCall={{ id: `cc-${name}`, name, input }} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText(detail)).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/)).not.toBeInTheDocument()
  })

  it.each(['ListAgents', 'CronList', 'TaskList'])(
    'renders parameterless %s without the unhandled fallback',
    name => {
      render(
        <ToolCallInline toolCall={{ id: `cc-${name}`, name, input: {} }} />
      )
      expect(screen.queryByText(/unhandled tool/)).not.toBeInTheDocument()
    }
  )

  it('renders MultiEdit with file, edit count, and one diff per edit', () => {
    inlineFileDiffProps.length = 0
    render(
      <ToolCallInline
        toolCall={{
          id: 'multi-edit',
          name: 'MultiEdit',
          input: {
            file_path: '/src/app.ts',
            edits: [
              { old_string: 'a', new_string: 'b' },
              { old_string: 'c', new_string: 'd' },
            ],
          },
        }}
      />
    )
    expect(screen.getByText('Multi Edit')).toBeInTheDocument()
    expect(screen.getByText('app.ts · 2 edits')).toBeInTheDocument()
    clickExpandTrigger()
    expect(
      inlineFileDiffProps.filter(p => p.filePath === '/src/app.ts')
    ).toHaveLength(2)
  })

  it('renders NotebookEdit with notebook, mode and cell', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'nb-edit',
          name: 'NotebookEdit',
          input: {
            notebook_path: '/nb/analysis.ipynb',
            cell_id: 'cell-3',
            edit_mode: 'insert',
            new_source: 'print(1)',
          },
        }}
      />
    )
    expect(screen.getByText('Notebook insert')).toBeInTheDocument()
    expect(screen.getByText('analysis.ipynb · cell-3')).toBeInTheDocument()
  })
})

describe('tool error indicator', () => {
  it('marks tool rows whose result is an error', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'err-tool',
          name: 'Bash',
          input: { command: 'false' },
          output: 'exit 1',
          is_error: true,
        }}
      />
    )
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('does not mark Bash rows that only exited non-zero', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'exit-tool',
          name: 'Bash',
          input: { command: 'which missing' },
          output: 'Exit code 127\nsh: missing: not found',
          is_error: true,
        }}
      />
    )
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
  })

  it('does not mark successful tool rows', () => {
    render(
      <ToolCallInline
        toolCall={{ id: 'ok-tool', name: 'Bash', input: { command: 'true' } }}
      />
    )
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
  })
})

describe('summarizeToolCall', () => {
  it('labels Codex sub-agent activity with the agent path', () => {
    expect(
      summarizeToolCall({
        id: 'sa1',
        name: 'SpawnAgent',
        input: {
          type: 'sub_agent_activity',
          kind: 'started',
          prompt: '/root/demo_one',
          receiver_thread_ids: ['t1'],
        },
      })
    ).toEqual({ label: 'Spawn Agent', detail: '/root/demo_one' })
  })

  it('uses the same friendly labels as the tool rows', () => {
    expect(
      summarizeToolCall({
        id: 's1',
        name: 'mcp__jean__create_session',
        input: { backend: 'claude' },
      })
    ).toEqual({ label: 'Jean: Create Session', detail: 'claude' })
    expect(
      summarizeToolCall({
        id: 's2',
        name: 'read_file',
        input: { target_file: '/src/a.ts' },
      })
    ).toEqual({ label: 'Read', detail: '/src/a.ts' })
    expect(
      summarizeToolCall({ id: 's3', name: 'TaskStop', input: { task_id: 't' } })
    ).toEqual({ label: 'Stop Task', detail: 't' })
  })

  it('keeps the tail of long paths', () => {
    const longPath = `/very/${'deep/'.repeat(30)}file.ts`
    const summary = summarizeToolCall({
      id: 's4',
      name: 'Edit',
      input: { file_path: longPath },
    })
    expect(summary.detail?.startsWith('…')).toBe(true)
    expect(summary.detail?.endsWith('file.ts')).toBe(true)
  })
})

describe('TaskCallInline nested agents', () => {
  it('uses resolved nested sub-tools and shows a spinner while running', () => {
    const nested = {
      id: 'nested-agent-2',
      name: 'Agent',
      input: { description: 'Child agent' },
      parent_tool_use_id: 'parent-agent-2',
    }
    // Fallback-grouped child: no parent_tool_use_id
    const grandchild = {
      id: 'nested-grep-2',
      name: 'Grep',
      input: { pattern: 'needle' },
    }
    const { container } = render(
      <TaskCallInline
        taskToolCall={{
          id: 'parent-agent-2',
          name: 'Agent',
          input: { description: 'Parent agent' },
        }}
        subToolCalls={[nested]}
        allToolCalls={[nested, grandchild]}
        nestedSubTools={{
          'parent-agent-2': [nested],
          'nested-agent-2': [grandchild],
        }}
        isStreaming
        isIncomplete
      />
    )
    clickExpandTrigger()
    // Parent + nested agent both show the working waveform
    expect(container.querySelectorAll('.working-waveform')).toHaveLength(2)
    // Nested agent reports its fallback-grouped child
    expect(screen.getAllByText('1 tool')).toHaveLength(2)
  })
})
