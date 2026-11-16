import { createRef } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test/test-utils'
import {
  FileMentionPopover,
  type FileMentionPopoverHandle,
} from './FileMentionPopover'
import type { WorktreeFile } from '@/types/chat'
import type * as FilesService from '@/services/files'
import type * as ProjectsService from '@/services/projects'

const filesByRoot: Record<string, WorktreeFile[]> = {
  '/tmp/current-worktree': [
    { relative_path: 'src/App.tsx', extension: 'tsx', is_dir: false },
    { relative_path: 'src/main.tsx', extension: 'tsx', is_dir: false },
    {
      relative_path: 'src/store/chat-store.ts',
      extension: 'ts',
      is_dir: false,
    },
    {
      relative_path: 'src/components/chat/ChatInput.tsx',
      extension: 'tsx',
      is_dir: false,
    },
    {
      relative_path: 'src/components/chat/FileMentionPopover.tsx',
      extension: 'tsx',
      is_dir: false,
    },
    { relative_path: 'src/services/files.ts', extension: 'ts', is_dir: false },
  ],
  '/tmp/docs': [
    { relative_path: 'docs/intro.md', extension: 'md', is_dir: false },
  ],
  '/tmp/build': [
    { relative_path: 'build/config.ts', extension: 'ts', is_dir: false },
  ],
  '/tmp/api': [
    { relative_path: 'api/server.ts', extension: 'ts', is_dir: false },
  ],
}

vi.mock('@/services/files', async () => {
  const actual = await vi.importActual<typeof FilesService>('@/services/files')
  return {
    ...actual,
    useWorktreeFiles: (rootPath: string | null) => ({
      data: rootPath ? (filesByRoot[rootPath] ?? []) : [],
    }),
  }
})

vi.mock('@/services/projects', async () => {
  const actual = await vi.importActual<typeof ProjectsService>(
    '@/services/projects'
  )
  return {
    ...actual,
    useProjects: () => ({
      data: [
        {
          id: 'current',
          name: 'Jean',
          path: '/tmp/jean',
          default_branch: 'main',
          added_at: 0,
          order: 0,
          linked_project_ids: ['docs', 'build', 'api'],
        },
        {
          id: 'docs',
          name: 'Docs',
          path: '/tmp/docs',
          default_branch: 'main',
          added_at: 0,
          order: 1,
          linked_project_ids: ['current'],
        },
        {
          id: 'build',
          name: 'Build',
          path: '/tmp/build',
          default_branch: 'main',
          added_at: 0,
          order: 2,
          linked_project_ids: ['current'],
        },
        {
          id: 'api',
          name: 'API',
          path: '/tmp/api',
          default_branch: 'main',
          added_at: 0,
          order: 3,
          linked_project_ids: ['current'],
        },
      ],
    }),
  }
})

describe('FileMentionPopover linked project scopes', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    Element.prototype.scrollIntoView = vi.fn()
  })

  beforeEach(() => {
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
  })

  it('shows linked projects in a scope selector and only switches file search after a project click', () => {
    const onSelectFile = vi.fn()

    render(
      <FileMentionPopover
        worktreePath="/tmp/current-worktree"
        worktreeId="wt-current"
        currentProjectId="current"
        open
        onOpenChange={vi.fn()}
        onSelectFile={onSelectFile}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    const scopeSelector = screen.getByLabelText('Project scope selector')
    expect(scopeSelector).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in Jean current' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'Search files in Docs' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in Build' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in API' })
    ).toBeInTheDocument()
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
    expect(screen.queryByText('docs/intro.md')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Search files in Docs' })
    )

    expect(
      screen.getByRole('button', { name: 'Search files in Docs' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('docs/intro.md')).toBeInTheDocument()
    expect(screen.queryByText('src/App.tsx')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('docs/intro.md'))

    expect(onSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'docs/intro.md',
        sourceRootPath: '/tmp/docs',
        sourceProjectId: 'docs',
        sourceProjectName: 'Docs',
      })
    )
  })

  it('cycles project scopes through the imperative keyboard handle', () => {
    const handleRef = createRef<FileMentionPopoverHandle | null>()

    render(
      <FileMentionPopover
        worktreePath="/tmp/current-worktree"
        worktreeId="wt-current"
        currentProjectId="current"
        open
        onOpenChange={vi.fn()}
        onSelectFile={vi.fn()}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
        handleRef={handleRef}
      />
    )

    expect(screen.queryByText(/Scope:/)).not.toBeInTheDocument()
    expect(screen.queryByText('Switch scope')).not.toBeInTheDocument()
    expect(screen.getByText('Ctrl')).toBeInTheDocument()
    expect(screen.getByText('Shift')).toBeInTheDocument()

    act(() => handleRef.current?.selectNextScope())

    expect(
      screen.getByRole('button', { name: 'Search files in Docs' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('docs/intro.md')).toBeInTheDocument()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })

    act(() => handleRef.current?.selectPreviousScope())

    expect(
      screen.getByRole('button', { name: 'Search files in Jean current' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
  })

  it('scrolls the active scope chip into view when keyboard cycling reaches hidden projects', () => {
    const handleRef = createRef<FileMentionPopoverHandle | null>()

    render(
      <FileMentionPopover
        worktreePath="/tmp/current-worktree"
        worktreeId="wt-current"
        currentProjectId="current"
        open
        onOpenChange={vi.fn()}
        onSelectFile={vi.fn()}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
        handleRef={handleRef}
      />
    )

    vi.mocked(Element.prototype.scrollIntoView).mockClear()

    act(() => handleRef.current?.selectNextScope())
    act(() => handleRef.current?.selectNextScope())
    act(() => handleRef.current?.selectNextScope())

    expect(
      screen.getByRole('button', { name: 'Search files in API' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })
  })

  it('keeps the file viewer prominent when several linked projects are shown', () => {
    render(
      <FileMentionPopover
        worktreePath="/tmp/current-worktree"
        worktreeId="wt-current"
        currentProjectId="current"
        open
        onOpenChange={vi.fn()}
        onSelectFile={vi.fn()}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    const commandList = document.querySelector('[data-slot="command-list"]')
    expect(commandList).toHaveClass('min-h-[280px]')
    expect(commandList).toHaveClass('max-h-[min(360px,60vh)]')

    expect(screen.queryByText('Projects')).not.toBeInTheDocument()
    const commandListEl = commandList as HTMLElement
    expect(screen.getByLabelText('Project scope selector')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in Jean current' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in Docs' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in Build' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search files in API' })
    ).toBeInTheDocument()
    expect(commandListEl).not.toHaveTextContent('Docs')
    expect(commandListEl).not.toHaveTextContent('Build')
    expect(commandListEl).not.toHaveTextContent('API')

    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
    expect(screen.getByText('src/main.tsx')).toBeInTheDocument()
    expect(screen.getByText('src/store/chat-store.ts')).toBeInTheDocument()
    expect(
      screen.getByText('src/components/chat/ChatInput.tsx')
    ).toBeInTheDocument()
    expect(
      screen.getByText('src/components/chat/FileMentionPopover.tsx')
    ).toBeInTheDocument()
    expect(screen.getByText('src/services/files.ts')).toBeInTheDocument()
  })
})
