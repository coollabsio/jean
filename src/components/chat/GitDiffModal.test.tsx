import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { GitDiffModal } from './GitDiffModal'
import type { GitDiff } from '@/types/git-diff'

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

vi.mock('./MemoizedFileDiff', () => ({
  MemoizedFileDiff: ({
    fileName,
    onLineSelected,
  }: {
    fileName: string
    onLineSelected?: (selection: {
      start: number
      end: number
      side: 'additions'
    }) => void
  }) => (
    <div data-testid="file-diff">
      {fileName}
      <button
        type="button"
        onClick={() =>
          onLineSelected?.({ start: 1, end: 1, side: 'additions' })
        }
      >
        Select line
      </button>
    </div>
  ),
  getStatusColor: () => 'text-blue-500',
}))

const mockDiff: GitDiff = {
  diff_type: 'uncommitted',
  base_ref: 'HEAD',
  target_ref: 'working tree',
  total_additions: 1,
  total_deletions: 0,
  raw_patch: '',
  files: [
    {
      path: 'database/migrations/2026_07_08_105014_add_uuid_to_cloud_init_scripts_table.php',
      old_path: null,
      status: 'modified',
      additions: 1,
      deletions: 0,
      is_binary: false,
      hunks: [],
    },
  ],
}

vi.mock('@/services/git-status', () => ({
  getGitDiff: vi.fn(async () => mockDiff),
  revertFile: vi.fn(),
  triggerImmediateGitPoll: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

function renderGitDiffModal() {
  return render(
    <GitDiffModal
      diffRequest={{
        type: 'uncommitted',
        worktreePath: '/tmp/worktree',
        baseBranch: 'main',
      }}
      onClose={vi.fn()}
    />
  )
}

function renderGitDiffModalWithPromptActions() {
  return render(
    <GitDiffModal
      diffRequest={{
        type: 'uncommitted',
        worktreePath: '/tmp/worktree',
        baseBranch: 'main',
      }}
      onClose={vi.fn()}
      onAddToPrompt={vi.fn()}
    />
  )
}

async function getDiffScrollContainer() {
  const diff = await screen.findByTestId('file-diff')
  const scrollContainer = diff.parentElement?.parentElement
  if (!scrollContainer) {
    throw new Error('Diff scroll container not found')
  }

  return scrollContainer as HTMLDivElement
}

describe('GitDiffModal keyboard shortcuts', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  })

  it('focuses the file filter when slash is pressed outside editable fields', async () => {
    const user = userEvent.setup()
    renderGitDiffModal()

    const filterInput = await screen.findByPlaceholderText('Filter files...')
    expect(filterInput).not.toHaveFocus()

    await user.keyboard('/')

    await waitFor(() => {
      expect(filterInput).toHaveFocus()
    })
  })

  it('does not steal slash while the user is typing in the file filter', async () => {
    renderGitDiffModal()

    const filterInput = await screen.findByPlaceholderText('Filter files...')

    const wasNotPrevented = fireEvent.keyDown(filterInput, {
      key: '/',
      cancelable: true,
    })

    expect(wasNotPrevented).toBe(true)
  })

  it('scrolls the diff viewer down when Cmd+ArrowDown is pressed', async () => {
    renderGitDiffModal()

    const scrollContainer = await getDiffScrollContainer()
    const scrollTo = vi.fn()
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      value: 1000,
    })
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    })
    scrollContainer.scrollTo = scrollTo

    // Outside native macOS, "mod" is Ctrl (see isModKeyEvent).
    const wasNotPrevented = fireEvent.keyDown(document, {
      key: 'ArrowDown',
      code: 'ArrowDown',
      ctrlKey: true,
      cancelable: true,
    })

    expect(wasNotPrevented).toBe(false)
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' })
  })

  it('scrolls the diff viewer up when Cmd+ArrowUp is pressed', async () => {
    renderGitDiffModal()

    const scrollContainer = await getDiffScrollContainer()
    const scrollTo = vi.fn()
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      value: 1000,
    })
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 1000,
    })
    scrollContainer.scrollTo = scrollTo

    const wasNotPrevented = fireEvent.keyDown(document, {
      key: 'ArrowUp',
      code: 'ArrowUp',
      ctrlKey: true,
      cancelable: true,
    })

    expect(wasNotPrevented).toBe(false)
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' })
  })

  it('does not scroll the diff viewer from editable fields', async () => {
    renderGitDiffModal()

    const filterInput = await screen.findByPlaceholderText('Filter files...')
    const scrollContainer = await getDiffScrollContainer()
    const scrollTo = vi.fn()
    scrollContainer.scrollTo = scrollTo

    const wasNotPrevented = fireEvent.keyDown(filterInput, {
      key: 'ArrowDown',
      code: 'ArrowDown',
      ctrlKey: true,
      cancelable: true,
    })

    expect(wasNotPrevented).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('allows long revert filenames to wrap inside the confirmation dialog', async () => {
    renderGitDiffModal()

    await screen.findByTestId('file-diff')
    fireEvent.keyDown(document, { key: 'Backspace' })

    const dialog = await screen.findByRole('alertdialog')
    const fileName = dialog.querySelector('.font-mono')
    expect(fileName).toHaveClass('break-all')
  })
})

describe('GitDiffModal diff comment actions', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  })

  it('shows only the yellow Add to prompt action for selected diff comments', async () => {
    const user = userEvent.setup()
    renderGitDiffModalWithPromptActions()

    await user.click(await screen.findByText('Select line'))
    await user.type(
      await screen.findByPlaceholderText('What should I do with this code?'),
      'fix this'
    )
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull()

    const addToPrompt = screen.getByRole('button', { name: /add to prompt/i })
    expect(addToPrompt.className).toContain('bg-primary')
    expect(addToPrompt.className).toContain('text-primary-foreground')
  })
})
