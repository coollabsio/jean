import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, render, screen, waitFor } from '@/test/test-utils'
import { toast } from 'sonner'
import { IMPORT_EXISTING_WORKTREE_EVENT } from '@/lib/import-existing-worktree'
import type { UnmanagedWorktree } from '@/types/projects'
import { ImportExistingWorktreeDialog } from './ImportExistingWorktreeDialog'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  native: false,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
}))

vi.mock('@/lib/transport', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    invoke: (...args: unknown[]) => mocks.invoke(...args),
  }
})

vi.mock('@/lib/environment', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    hasBackend: () => true,
    isNativeApp: () => mocks.native,
    isLocalBackend: () => mocks.native,
  }
})

const feature: UnmanagedWorktree = {
  path: '/repo/.worktrees/feature-login',
  branch: 'feature/login',
  head: 'a1b2c3d4e5f67890',
  headShort: 'a1b2c3d',
  prunable: false,
  locked: false,
  detached: false,
  bare: false,
}

const hotfix: UnmanagedWorktree = {
  path: '/repo/.worktrees/hotfix',
  branch: null,
  head: 'deadbeefcafebabe',
  headShort: 'deadbee',
  prunable: false,
  locked: true,
  detached: true,
  bare: false,
}

function openDialog() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(IMPORT_EXISTING_WORKTREE_EVENT, {
        detail: { projectId: 'project-1' },
      })
    )
  })
}

describe('ImportExistingWorktreeDialog', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.native = false
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('lists discovered worktrees', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') return [feature, hotfix]
      return null
    })

    render(<ImportExistingWorktreeDialog />)
    openDialog()

    expect(await screen.findByText(feature.path)).toBeInTheDocument()
    expect(screen.getByText(hotfix.path)).toBeInTheDocument()
    expect(screen.getByText('feature/login · a1b2c3d')).toBeInTheDocument()
    expect(
      screen.getByText('detached HEAD · deadbee · locked')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Worktree path')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('list_unmanaged_worktrees', {
      projectId: 'project-1',
    })
  })

  it('imports only the selected worktrees', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') return [feature, hotfix]
      if (command === 'import_worktree') {
        return {
          id: 'imported-1',
          name: 'feature-login',
          project_id: 'project-1',
        }
      }
      return null
    })

    render(<ImportExistingWorktreeDialog />)
    openDialog()

    await screen.findByText(feature.path)
    await user.click(
      screen.getByRole('checkbox', { name: `Import ${feature.path}` })
    )
    await user.click(screen.getByRole('button', { name: 'Import (1)' }))

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('import_worktree', {
        projectId: 'project-1',
        path: feature.path,
      })
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'import_worktree',
      expect.objectContaining({ path: hotfix.path })
    )
    expect(toast.success).toHaveBeenCalledWith('Worktree imported', {
      description: 'feature-login',
    })
  })

  it('shows an empty state and can import a path entered by hand', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') return []
      if (command === 'import_worktree') {
        return { id: 'imported-manual', name: 'manual-wt' }
      }
      return null
    })

    render(<ImportExistingWorktreeDialog />)
    openDialog()

    expect(
      await screen.findByText('No unmanaged worktrees found for this project.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()

    await user.type(screen.getByLabelText('Worktree path'), '/tmp/manual-wt')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('/tmp/manual-wt')).toBeInTheDocument()
    expect(screen.getByText('Entered path')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import (1)' }))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('import_worktree', {
        projectId: 'project-1',
        path: '/tmp/manual-wt',
      })
    })
  })

  it('shows list errors and keeps the dialog open when an import fails', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') {
        throw new Error('git failed')
      }
      return null
    })

    const { unmount } = render(<ImportExistingWorktreeDialog />)
    openDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent('git failed')
    unmount()

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') return [feature]
      if (command === 'import_worktree') {
        throw new Error('Path is not a git worktree')
      }
      return null
    })

    render(<ImportExistingWorktreeDialog />)
    openDialog()

    await screen.findByText(feature.path)
    await user.click(
      screen.getByRole('checkbox', { name: `Import ${feature.path}` })
    )
    await user.click(screen.getByRole('button', { name: 'Import (1)' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to import worktree', {
        description: 'Path is not a git worktree',
      })
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(feature.path)).toBeInTheDocument()
  })

  it('shows prunable worktrees but does not select them', async () => {
    const user = userEvent.setup()
    const gone: UnmanagedWorktree = {
      path: '/repo/.worktrees/gone',
      branch: 'gone',
      head: '1234abcd',
      headShort: '1234abc',
      prunable: true,
      locked: false,
      detached: false,
      bare: false,
    }
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') return [feature, gone]
      if (command === 'import_worktree') {
        return { id: 'imported-1', name: 'feature-login' }
      }
      return null
    })

    render(<ImportExistingWorktreeDialog />)
    openDialog()

    expect(await screen.findByText(gone.path)).toBeInTheDocument()
    expect(screen.getByText('gone · 1234abc · prunable')).toBeInTheDocument()
    const goneCheckbox = screen.getByRole('checkbox', {
      name: `Import ${gone.path}`,
    })
    expect(goneCheckbox).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(
      screen.getByRole('checkbox', { name: `Import ${feature.path}` })
    ).toBeChecked()
    expect(goneCheckbox).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Import (1)' }))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('import_worktree', {
        projectId: 'project-1',
        path: feature.path,
      })
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'import_worktree',
      expect.objectContaining({ path: gone.path })
    )
  })

  it('rejects the project checkout and the main checkout in the dialog', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_unmanaged_worktrees') {
        return {
          worktrees: [feature],
          blockedPaths: [
            { path: '/repo/', kind: 'project' },
            { path: '/repo-main', kind: 'main' },
          ],
        }
      }
      return null
    })

    render(<ImportExistingWorktreeDialog />)
    openDialog()
    await screen.findByText(feature.path)

    const pathInput = screen.getByLabelText('Worktree path')
    await user.type(pathInput, '/repo')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot import the project checkout: /repo'
    )
    expect(
      screen.queryByRole('checkbox', { name: 'Import /repo' })
    ).not.toBeInTheDocument()

    await user.clear(pathInput)
    await user.type(pathInput, '/repo-main/')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Cannot import the repository's main checkout: /repo-main/"
    )
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'import_worktree',
      expect.anything()
    )
  })
})
