import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import {
  MessageDiffModal,
  undoEdit,
  applyEdit,
  patchFromEdits,
  reconstructFileStates,
  extractFilePatch,
  type EditTool,
} from './MessageDiffModal'
import { useState, type ReactNode } from 'react'
import userEvent from '@testing-library/user-event'
import { invoke, invokeForOptionalServer } from '@/lib/transport'

let tauriAvailable = false
let editorAvailable = false
let mobile = false
let mockFileContent: string | undefined = undefined
let mockCheckpointRawPatch = ''

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mobile,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => tauriAvailable,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => false,
  isLocalBackend: () => false,
  canOpenInEditor: () => editorAvailable,
}))

vi.mock('@/lib/transport', () => {
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === 'read_file_content') {
      if (mockFileContent === undefined) {
        throw new Error('file content not mocked')
      }
      return mockFileContent
    }
    if (cmd === 'get_ai_checkpoint_diff') {
      return { raw_patch: mockCheckpointRawPatch, files: [] }
    }
    if (cmd === 'open_file_in_default_app') return undefined
    throw new Error(`unexpected invoke: ${cmd}`)
  })
  return {
    invoke,
    invokeForOptionalServer: vi.fn(
      (_serverId: string | undefined, cmd: string, args?: unknown) =>
        invoke(cmd, args)
    ),
  }
})

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff }: { fileDiff: unknown }) => {
    const [initialFileDiff] = useState(fileDiff)
    return <div data-testid="file-diff">{JSON.stringify(initialFileDiff)}</div>
  },
  EditProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@pierre/diffs/edit', () => ({
  // Constructable stub; pierre-edit does `new Editor(options)`.
  Editor: vi.fn(),
}))
const patch = `Index: src/example.ts
===================================================================
--- src/example.ts
+++ src/example.ts
@@ -1,1 +1,2 @@
 const a = 1
+const b = 2
`

describe('undoEdit', () => {
  it('restores old_string when new_string emptied the whole file', () => {
    expect(undoEdit('', 'line1\nline2\n', '')).toBe('line1\nline2\n')
  })

  it('replaces the last occurrence of new_string with old_string', () => {
    expect(undoEdit('aaXbbXcc', 'Y', 'X')).toBe('aaXbbYcc')
  })

  it('leaves partial empty-new_string deletes unchanged', () => {
    // Without a deletion index we cannot uniquely re-insert.
    expect(undoEdit('remaining', 'deleted-part', '')).toBe('remaining')
  })
})

describe('replace_all edits', () => {
  it('undoes every occurrence when the edit used replace_all', () => {
    expect(undoEdit('Y and Y and Y', 'X', 'Y', true)).toBe('X and X and X')
  })

  it('applies every occurrence forward when the edit used replace_all', () => {
    expect(applyEdit('X X', edit('X', 'Y', { replace_all: true }))).toBe('Y Y')
    expect(applyEdit('X X', edit('X', 'Y'))).toBe('Y X')
  })
})

const FILE = '/repo/src/file.ts'

function edit(
  oldStr: string,
  newStr: string,
  extra: Partial<EditTool['input']> = {}
): EditTool {
  return {
    name: 'Edit',
    input: {
      file_path: FILE,
      old_string: oldStr,
      new_string: newStr,
      ...extra,
    },
  }
}

function write(content: string): EditTool {
  return {
    name: 'Write',
    input: { file_path: FILE, old_string: '', new_string: content },
  }
}

describe('reconstructFileStates', () => {
  it('reverse-replays Edits from disk content', () => {
    expect(reconstructFileStates('a\nc\n', [edit('b\n', 'c\n')], [])).toEqual({
      before: 'a\nb\n',
      after: 'a\nc\n',
    })
  })

  it('handles a later Write after an earlier Edit (prior content known)', () => {
    // Earlier message wrote the file, this message edited it, a later message
    // overwrote everything — the disk no longer reflects this edit.
    const states = reconstructFileStates(
      'rewritten\n',
      [edit('two\n', '2\n')],
      [write('rewritten\n')],
      [write('one\ntwo\n')]
    )
    expect(states).toEqual({ before: 'one\ntwo\n', after: 'one\n2\n' })
  })

  it('returns null after a later Write when prior content is unknown', () => {
    // Caller falls back to patchFromEdits instead of diffing an empty file.
    expect(
      reconstructFileStates(
        'rewritten\n',
        [edit('two\n', '2\n')],
        [write('rewritten\n')]
      )
    ).toBeNull()
  })

  it('handles a Write in this message followed by a later Edit', () => {
    expect(
      reconstructFileStates('a\nc\n', [write('a\nb\n')], [edit('b\n', 'c\n')])
    ).toEqual({ before: '', after: 'a\nb\n' })
  })

  it('derives the after state from this Write when a later Write exists', () => {
    expect(
      reconstructFileStates(
        'final\n',
        [write('mine\n'), edit('mine', 'ours')],
        [write('final\n')]
      )
    ).toEqual({ before: '', after: 'ours\n' })
  })

  it('diffs an overwrite Write against the previously known content', () => {
    expect(
      reconstructFileStates(
        'new\nshared\n',
        [write('new\nshared\n')],
        [],
        [write('old\nshared\n'), edit('shared', 'shared')]
      )
    ).toEqual({ before: 'old\nshared\n', after: 'new\nshared\n' })
  })
})

describe('patchFromEdits', () => {
  it('builds a deletion patch for a single empty-new_string edit', () => {
    const raw = patchFromEdits('docs/service.md', [
      {
        name: 'Edit',
        input: {
          file_path: '/repo/docs/service.md',
          old_string: 'alpha\nbeta\n',
          new_string: '',
        },
      },
    ])
    expect(raw).toBeTruthy()
    expect(raw).toContain('-alpha')
    expect(raw).toContain('-beta')
  })
})

describe('extractFilePatch', () => {
  const raw = [
    'diff --git a/deploy/nginx.conf b/deploy/nginx.conf',
    '--- a/deploy/nginx.conf',
    '+++ b/deploy/nginx.conf',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/nginx.conf b/nginx.conf',
    '--- a/nginx.conf',
    '+++ b/nginx.conf',
    '@@ -1 +1 @@',
    '-c',
    '+d',
    '',
  ].join('\n')

  it('returns only the section of the requested file', () => {
    const section = extractFilePatch(raw, 'nginx.conf')
    expect(section).toContain('+d')
    expect(section).not.toContain('+b')
    expect(extractFilePatch(raw, 'deploy/nginx.conf')).toContain('+b')
  })

  it('returns null when the file is not in the patch', () => {
    expect(extractFilePatch(raw, 'missing.txt')).toBeNull()
  })
})

describe('MessageDiffModal file source', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    vi.mocked(invokeForOptionalServer).mockClear()
    mockFileContent = undefined
    mockCheckpointRawPatch = ''
  })

  it('reads the file from the server that owns it', async () => {
    mockFileContent = 'const a = 2\n'
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/a.ts"
        worktreePath="/repo"
        edits={[
          {
            name: 'Edit',
            input: {
              file_path: '/repo/a.ts',
              old_string: 'const a = 1',
              new_string: 'const a = 2',
            },
          },
        ]}
        serverId="devserver"
      />
    )

    expect(await screen.findByTestId('file-diff')).toBeInTheDocument()
    expect(invokeForOptionalServer).toHaveBeenCalledWith(
      'devserver',
      'read_file_content',
      { path: '/repo/a.ts' }
    )
  })

  it('shows the turn checkpoint diff for a file changed without file tools', async () => {
    mockCheckpointRawPatch = [
      'diff --git a/other.ts b/other.ts',
      '--- a/other.ts',
      '+++ b/other.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/deploy/nginx.conf b/deploy/nginx.conf',
      '--- a/deploy/nginx.conf',
      '+++ b/deploy/nginx.conf',
      '@@ -1,1 +1,2 @@',
      ' listen 80;',
      '+return 301;',
      '',
    ].join('\n')
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/deploy/nginx.conf"
        worktreePath="/repo"
        edits={[]}
        checkpointDiff={{
          worktreeId: 'wt-1',
          checkpointId: 'cp-1',
          path: 'deploy/nginx.conf',
        }}
      />
    )

    const diff = await screen.findByTestId('file-diff')
    expect(diff.textContent).toContain('return 301;')
    expect(diff.textContent).not.toContain('other.ts')
    expect(screen.getByText('+1')).toBeVisible()
    expect(invoke).not.toHaveBeenCalledWith(
      'read_file_content',
      expect.anything()
    )
  })
})

describe('MessageDiffModal header', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    tauriAvailable = false
    editorAvailable = false
    mobile = false
    mockFileContent = undefined
  })

  it('shows change stats as text next to the filename, not as a Current change button', async () => {
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    expect(await screen.findByText('example.ts')).toBeVisible()
    expect(screen.getByText('+1')).toBeVisible()
    expect(screen.getByText('-0')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Current change/i })
    ).not.toBeInTheDocument()
  })

  it('does not show an All changes button when native git diff is available', async () => {
    tauriAvailable = true

    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    expect(await screen.findByText('example.ts')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /All changes/i })
    ).not.toBeInTheDocument()
  })

  it('keeps the close button anchored to the dialog corner', async () => {
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    const closeButton = await screen.findByRole('button', { name: 'Close' })
    expect(closeButton.parentElement?.className).toContain('absolute')
    expect(closeButton.parentElement?.className).toContain('right-4')
    expect(closeButton.parentElement?.className).toContain('top-4')
  })

  it('groups the open-in-editor and close buttons together', async () => {
    editorAvailable = true

    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    const openButton = await screen.findByRole('button', {
      name: /Open in Editor/i,
    })
    const closeButton = screen.getByRole('button', { name: 'Close' })

    expect(openButton.parentElement).toBe(closeButton.parentElement)
  })

  it('opens a relative remote file under its worktree path', async () => {
    editorAvailable = true

    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="apps/server/src/integration_routes.rs"
        worktreePath="/srv/jean/project"
        edits={[]}
        patch={patch}
      />
    )

    await userEvent.click(
      await screen.findByRole('button', { name: /Open in Editor/i })
    )

    expect(invoke).toHaveBeenCalledWith('open_file_in_default_app', {
      path: '/srv/jean/project/apps/server/src/integration_routes.rs',
      editor: undefined,
    })
  })

  it('hides the open-in-editor button on mobile', async () => {
    editorAvailable = true
    mobile = true

    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    expect(await screen.findByText('example.ts')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Open in Editor/i })
    ).not.toBeInTheDocument()
  })

  it('refreshes the rendered diff when a live FileChange patch updates while open', async () => {
    const firstPatch = `Index: src/example.ts
===================================================================
--- src/example.ts
+++ src/example.ts
@@ -1,1 +1,2 @@
 const a = 1
+const b = 2
`
    const updatedPatch = `Index: src/example.ts
===================================================================
--- src/example.ts
+++ src/example.ts
@@ -1,1 +1,3 @@
 const a = 1
+const b = 2
+const c = 3
`

    const { rerender } = render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={firstPatch}
      />
    )

    expect(await screen.findByTestId('file-diff')).toHaveTextContent('b = 2')
    expect(screen.getByTestId('file-diff')).not.toHaveTextContent('c = 3')

    rerender(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={updatedPatch}
      />
    )

    expect(screen.getByTestId('file-diff')).toHaveTextContent('c = 3')
  })
})

describe('MessageDiffModal empty-file edits', () => {
  beforeEach(() => {
    tauriAvailable = false
    mockFileContent = undefined
  })

  it('shows deletions when AI removes all file content (empty on-disk file)', async () => {
    // File was emptied by Edit(old=full content, new="").
    mockFileContent = ''
    const oldContent = [
      '# Service design',
      '',
      'Coolify runs services in Docker.',
      'This paragraph is gone.',
    ].join('\n')

    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/docs/coolify-docs-design-services.md"
        worktreePath="/repo"
        edits={[
          {
            name: 'Edit',
            input: {
              file_path: '/repo/docs/coolify-docs-design-services.md',
              old_string: oldContent,
              new_string: '',
            },
          },
        ]}
      />
    )

    const diff = await screen.findByTestId('file-diff')
    expect(diff).toHaveTextContent('Service design')
    expect(diff).toHaveTextContent('Coolify runs services')
    // Full-file wipe: +0 / -N in the dialog title
    expect(screen.getByText('+0')).toBeVisible()
    expect(screen.getByText('-4')).toBeVisible()
  })

  it('does not treat an empty file as "no content loaded"', async () => {
    mockFileContent = ''
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/docs/empty.md"
        worktreePath="/repo"
        edits={[
          {
            name: 'Edit',
            input: {
              file_path: '/repo/docs/empty.md',
              old_string: 'only line\n',
              new_string: '',
            },
          },
        ]}
      />
    )

    expect(await screen.findByTestId('file-diff')).toBeVisible()
    expect(screen.queryByText('No changes to display')).not.toBeInTheDocument()
  })

  it('falls back to edit-string patch when reverse-replay cannot reconstruct', async () => {
    // File still has leftover content; empty new_string partial delete can't be
    // uniquely reversed from disk alone.
    mockFileContent = 'kept tail\n'
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/docs/partial.md"
        worktreePath="/repo"
        edits={[
          {
            name: 'Edit',
            input: {
              file_path: '/repo/docs/partial.md',
              old_string: 'removed head\n',
              new_string: '',
            },
          },
        ]}
      />
    )

    const diff = await screen.findByTestId('file-diff')
    expect(diff).toHaveTextContent('removed head')
    expect(screen.queryByText('No changes to display')).not.toBeInTheDocument()
  })
  it('diffs an overwrite Write against earlier known content', async () => {
    mockFileContent = 'new line\nshared\n'
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/file.ts"
        worktreePath="/repo"
        edits={[write('new line\nshared\n')]}
        previousEdits={[write('old line\nshared\n')]}
      />
    )

    const diff = await screen.findByTestId('file-diff')
    expect(diff).toHaveTextContent('old line')
    expect(screen.getByText('+1')).toBeVisible()
    expect(screen.getByText('-1')).toBeVisible()
  })
})
