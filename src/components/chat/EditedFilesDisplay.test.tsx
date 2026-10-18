import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import {
  EditedFilesDisplay,
  getClaudeFileEdits,
  getUncoveredCheckpointFiles,
} from './EditedFilesDisplay'
import type { ChatMessage, ToolCall } from '@/types/chat'
import type { AiCheckpoint } from '@/types/checkpoints'

const diffModalMock = vi.hoisted(() => vi.fn())
const checkpointsMock = vi.hoisted(() => ({ value: [] as unknown[] }))

vi.mock('@/services/checkpoints', () => ({
  checkpointQueryKeys: {
    worktree: (worktreeId: string) => ['ai-checkpoints', worktreeId],
  },
  listAiCheckpoints: vi.fn(async () => checkpointsMock.value),
}))

function makeCheckpoint(overrides: Partial<AiCheckpoint> = {}): AiCheckpoint {
  return {
    id: 'cp-1',
    worktreeId: 'wt-1',
    sessionId: 's-1',
    userMessageId: 'user-1',
    userMessagePreview: 'fix nginx',
    createdAt: 1,
    startCommit: 'a',
    endCommit: 'b',
    worktreePath: '/repo',
    status: 'finalized',
    filesChanged: [
      {
        path: 'deploy/nginx.conf',
        status: 'modified',
        additions: 16,
        deletions: 3,
      },
      { path: 'src/edited.ts', status: 'modified', additions: 1, deletions: 1 },
    ],
    totalAdditions: 17,
    totalDeletions: 4,
    ...overrides,
  }
}

describe('getUncoveredCheckpointFiles', () => {
  it('keeps only files no file tool call changed', () => {
    expect(
      getUncoveredCheckpointFiles(makeCheckpoint(), ['/repo/src/edited.ts'])
    ).toEqual([
      {
        filePath: '/repo/deploy/nginx.conf',
        path: 'deploy/nginx.conf',
        additions: 16,
        deletions: 3,
      },
    ])
  })

  it('treats relative tool paths as covered', () => {
    expect(
      getUncoveredCheckpointFiles(makeCheckpoint(), [
        'deploy/nginx.conf',
        'src/edited.ts',
      ])
    ).toEqual([])
  })

  it('returns nothing without a checkpoint', () => {
    expect(getUncoveredCheckpointFiles(undefined, [])).toEqual([])
  })
})

vi.mock('./MessageDiffModal', () => ({
  MessageDiffModal: (
    props: { patch?: string | null } & Record<string, unknown>
  ) => {
    diffModalMock(props)
    return <div data-testid="message-diff-modal">{props.patch}</div>
  },
}))

describe('EditedFilesDisplay', () => {
  beforeEach(() => {
    diffModalMock.mockClear()
    checkpointsMock.value = []
  })

  it('lists files the finished turn changed through Bash and opens their checkpoint diff', async () => {
    checkpointsMock.value = [
      makeCheckpoint({ id: 'other', userMessageId: 'user-0' }),
      makeCheckpoint(),
    ]
    const toolCalls: ToolCall[] = [
      {
        id: 'edit-1',
        name: 'Edit',
        input: {
          file_path: '/repo/src/edited.ts',
          old_string: 'a',
          new_string: 'b',
        },
      },
      { id: 'bash-1', name: 'Bash', input: { command: 'sed -i ...' } },
    ]

    render(
      <EditedFilesDisplay
        toolCalls={toolCalls}
        worktreePath="/repo"
        worktreeId="wt-1"
        turnUserMessageId="user-1"
        serverId="devserver"
      />
    )

    const trigger = await screen.findByRole('button', {
      name: 'Edited 2 files',
    })
    fireEvent.click(trigger)
    expect(screen.getByText('+16')).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: 'View changes to nginx.conf' })
    )

    expect(diffModalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: '/repo/deploy/nginx.conf',
        edits: [],
        serverId: 'devserver',
        checkpointDiff: {
          worktreeId: 'wt-1',
          checkpointId: 'cp-1',
          path: 'deploy/nginx.conf',
        },
      })
    )
  })

  it('does not add checkpoint files without a finished turn', () => {
    checkpointsMock.value = [makeCheckpoint()]
    render(
      <EditedFilesDisplay
        toolCalls={[{ id: 'bash-1', name: 'Bash', input: { command: 'x' } }]}
        worktreeId="wt-1"
      />
    )
    expect(
      screen.queryByRole('button', { name: /Edited/ })
    ).not.toBeInTheDocument()
  })

  it('renders Codex FileChange tool calls with file stats', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'fc-1',
        name: 'FileChange',
        input: [
          {
            path: 'src-tauri/src/chat/codex.rs',
            kind: { type: 'update' },
            diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context\n',
          },
          {
            path: 'src/components/chat/EditedFilesDisplay.tsx',
            kind: { type: 'update' },
            diff: '@@ -10,2 +10,2 @@\n-old\n+new\n',
          },
        ],
      },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    const trigger = screen.getByRole('button', { name: 'Edited 2 files' })
    expect(trigger).toBeVisible()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('codex.rs')).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('codex.rs')).toBeVisible()
    expect(screen.getByText('EditedFilesDisplay.tsx')).toBeVisible()
    expect(screen.getByText('+2')).toBeVisible()
    expect(screen.getAllByText('-1')).toHaveLength(2)
  })

  it('opens a Codex FileChange diff as a unified patch', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'fc-1',
        name: 'FileChange',
        input: [
          {
            path: 'src-tauri/src/chat/codex.rs',
            diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context\n',
          },
        ],
      },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edited 1 file' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'View changes to codex.rs' })
    )

    expect(screen.getByTestId('message-diff-modal')).toBeVisible()
    expect(diffModalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'src-tauri/src/chat/codex.rs',
        edits: [],
        patch: expect.stringContaining(
          '--- src-tauri/src/chat/codex.rs\n+++ src-tauri/src/chat/codex.rs'
        ),
      })
    )
    expect(diffModalMock.mock.lastCall?.[0].patch).toContain('+another line')
  })

  it('truncates long mobile file modification names so stats remain visible', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'fc-1',
        name: 'FileChange',
        input: [
          {
            path: 'database/migrations/2026_06_11_232520_create_connected_accounts_table.php',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
      },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edited 1 file' }))
    expect(
      screen.getByText('2026_06_11_232520_create_connected_accounts_table.php')
    ).toHaveClass('truncate')
    expect(screen.getByText('+1')).toBeVisible()
    expect(screen.getByText('-1')).toBeVisible()
  })

  it('shows Claude Write, MultiEdit, and NotebookEdit file changes', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'w-1',
        name: 'Write',
        input: { file_path: '/repo/src/new-file.ts', content: 'a\nb\nc\n' },
      },
      {
        id: 'm-1',
        name: 'MultiEdit',
        input: {
          file_path: '/repo/src/multi.ts',
          edits: [
            { old_string: 'one\n', new_string: 'uno\n' },
            { old_string: 'two\n', new_string: 'dos\ntres\n' },
          ],
        },
      },
      {
        id: 'n-1',
        name: 'NotebookEdit',
        input: {
          notebook_path: '/repo/analysis.ipynb',
          cell_id: 'cell-1',
          new_source: 'print(1)',
        },
      },
      { id: 'r-1', name: 'Read', input: { file_path: '/repo/src/read.ts' } },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edited 3 files' }))

    expect(screen.getByText('new-file.ts')).toBeVisible()
    expect(screen.getByText('multi.ts')).toBeVisible()
    expect(screen.getByText('analysis.ipynb')).toBeVisible()
    expect(screen.queryByText('read.ts')).not.toBeInTheDocument()
    expect(screen.getAllByText('+3')).toHaveLength(2)
    expect(screen.getByText('-2')).toBeVisible()
  })

  it('passes normalized MultiEdit edits to the diff modal', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'm-1',
        name: 'MultiEdit',
        input: {
          file_path: '/repo/src/multi.ts',
          edits: [
            { old_string: 'one', new_string: 'uno' },
            { old_string: 'two', new_string: 'dos' },
          ],
        },
      },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edited 1 file' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'View changes to multi.ts' })
    )

    expect(diffModalMock.mock.lastCall?.[0].edits).toEqual([
      {
        name: 'Edit',
        input: {
          file_path: '/repo/src/multi.ts',
          old_string: 'one',
          new_string: 'uno',
        },
      },
      {
        name: 'Edit',
        input: {
          file_path: '/repo/src/multi.ts',
          old_string: 'two',
          new_string: 'dos',
        },
      },
    ])
  })
  it('skips failed or denied edit tool calls', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'e-1',
        name: 'Edit',
        input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
        is_error: true,
      },
      {
        id: 'w-1',
        name: 'Write',
        input: { file_path: '/repo/b.ts', content: 'x' },
        is_error: true,
      },
    ]
    expect(toolCalls.flatMap(getClaudeFileEdits)).toEqual([])

    const { container } = render(<EditedFilesDisplay toolCalls={toolCalls} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps replace_all on Edit and MultiEdit inner edits', () => {
    expect(
      getClaudeFileEdits({
        id: 'e-1',
        name: 'Edit',
        input: {
          file_path: '/repo/a.ts',
          old_string: 'a',
          new_string: 'b',
          replace_all: true,
        },
      })
    ).toEqual([
      {
        name: 'Edit',
        input: {
          file_path: '/repo/a.ts',
          old_string: 'a',
          new_string: 'b',
          replace_all: true,
        },
      },
    ])
    expect(
      getClaudeFileEdits({
        id: 'm-1',
        name: 'MultiEdit',
        input: {
          file_path: '/repo/a.ts',
          edits: [{ old_string: 'a', new_string: 'b', replace_all: true }],
        },
      })[0]?.input.replace_all
    ).toBe(true)
  })

  it('passes earlier and later edits of the selected file to the diff modal', () => {
    const file = '/repo/src/a.ts'
    const messages = [
      {
        id: 'm0',
        tool_calls: [
          { id: 't0', name: 'Write', input: { file_path: file, content: 'x' } },
          {
            id: 't0b',
            name: 'Write',
            input: { file_path: '/repo/other.ts', content: 'y' },
          },
        ],
      },
      {
        id: 'm1',
        tool_calls: [
          {
            id: 't1',
            name: 'Edit',
            input: { file_path: file, old_string: 'x', new_string: 'z' },
          },
        ],
      },
      {
        id: 'm2',
        tool_calls: [
          {
            id: 't2',
            name: 'Edit',
            input: { file_path: file, old_string: 'z', new_string: 'w' },
            is_error: true,
          },
          { id: 't3', name: 'Write', input: { file_path: file, content: 'q' } },
        ],
      },
    ] as unknown as ChatMessage[]

    render(
      <EditedFilesDisplay
        toolCalls={messages[1]?.tool_calls}
        getMessages={() => messages}
        messageIndex={1}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edited 1 file' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'View changes to a.ts' })
    )

    const props = diffModalMock.mock.lastCall?.[0]
    expect(props.previousEdits).toEqual([
      {
        name: 'Write',
        input: { file_path: file, old_string: '', new_string: 'x' },
      },
    ])
    expect(props.subsequentEdits).toEqual([
      {
        name: 'Write',
        input: { file_path: file, old_string: '', new_string: 'q' },
      },
    ])
  })
})
