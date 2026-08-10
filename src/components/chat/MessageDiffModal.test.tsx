import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MessageDiffModal, undoEdit, patchFromEdits } from './MessageDiffModal'
import { useState, type ReactNode } from 'react'

let tauriAvailable = false
let editorAvailable = false
let mobile = false
let mockFileContent: string | undefined = undefined

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

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'read_file_content') {
      if (mockFileContent === undefined) {
        throw new Error('file content not mocked')
      }
      return mockFileContent
    }
    throw new Error(`unexpected invoke: ${cmd}`)
  }),
}))

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

describe('MessageDiffModal header', () => {
  beforeEach(() => {
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
})
