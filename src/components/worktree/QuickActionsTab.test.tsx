import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { QuickActionsTab } from './QuickActionsTab'
import type { ProjectRemote } from '@/services/projects'

const onCreateWorktree = vi.fn()
const onBaseSession = vi.fn()

const mocks = vi.hoisted(() => ({
  favoriteBaseBranches: [] as string[],
  patchPreferences: vi.fn(),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { favorite_base_branches: mocks.favoriteBaseBranches },
  }),
  usePatchPreferences: () => ({ mutate: mocks.patchPreferences }),
}))

vi.mock('@/services/projects', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    // Remotes for the selected base are loaded inside the tab; tests pass
    // remotes via props as the fallback and leave this empty.
    useProjectRemotes: () => ({ data: undefined }),
  }
})

const sampleBranches = ['develop', 'main', 'release/1.0', 'v4.x']

function renderTab(props: Partial<Parameters<typeof QuickActionsTab>[0]> = {}) {
  return render(
    <QuickActionsTab
      hasBaseSession={false}
      onCreateWorktree={onCreateWorktree}
      onBaseSession={onBaseSession}
      isCreating={false}
      projectId="project-1"
      jeanConfig={null}
      defaultBranch="main"
      branches={sampleBranches}
      {...props}
    />
  )
}

const twoRemotes: ProjectRemote[] = [
  { name: 'origin', repo: 'coollabsio/jean' },
  { name: 'fork', repo: 'fsioni/jean' },
]

beforeEach(() => {
  onCreateWorktree.mockClear()
  onBaseSession.mockClear()
  mocks.favoriteBaseBranches = []
  mocks.patchPreferences.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('QuickActionsTab', () => {
  describe('single remote (default behaviour)', () => {
    it('keeps the base session and generic new worktree actions', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      expect(screen.getByText('New Base Session')).toBeInTheDocument()
      expect(screen.getByText('New Worktree')).toBeInTheDocument()
      expect(screen.queryByText('origin/main')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Create' }))
      expect(onCreateWorktree).toHaveBeenCalledWith(undefined, 'main')
    })

    it('passes the custom branch name with the selected base branch', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.type(screen.getByLabelText('Branch name'), 'my-feature')
      await user.click(screen.getByRole('button', { name: 'Create' }))

      expect(onCreateWorktree).toHaveBeenCalledWith('my-feature', 'main')
    })

    it('shows a searchable base branch combobox defaulting to the project default', () => {
      renderTab({ remotes: [{ name: 'origin' }] })

      const combobox = screen.getByRole('combobox', { name: 'Base branch' })
      expect(combobox).toBeInTheDocument()
      expect(combobox).toHaveTextContent('main')
    })

    it('creates from a different base branch chosen in the dropdown', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.click(screen.getByRole('combobox', { name: 'Base branch' }))
      await user.click(await screen.findByRole('option', { name: /develop/ }))

      await user.click(screen.getByRole('button', { name: 'Create' }))
      expect(onCreateWorktree).toHaveBeenCalledWith(undefined, 'develop')
    })

    it('filters base branches when typing in the search field', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.click(screen.getByRole('combobox', { name: 'Base branch' }))
      const listbox = await screen.findByRole('listbox')
      const search = screen.getByPlaceholderText('Search branches...')
      await user.type(search, 'rel')

      expect(
        within(listbox).getByRole('option', { name: /release\/1\.0/ })
      ).toBeInTheDocument()
      expect(
        within(listbox).queryByRole('option', { name: /^main$/ })
      ).not.toBeInTheDocument()
      expect(
        within(listbox).queryByRole('option', { name: /^develop$/ })
      ).not.toBeInTheDocument()
    })

    it('stars a branch without selecting it and persists via preferences', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.click(screen.getByRole('combobox', { name: 'Base branch' }))
      await user.click(screen.getByRole('button', { name: 'Star v4.x' }))

      expect(mocks.patchPreferences).toHaveBeenCalledWith({
        favorite_base_branches: ['project-1:v4.x'],
      })
      // Star click should not select/close via Create path
      expect(onCreateWorktree).not.toHaveBeenCalled()
      // Combobox still shows previous selection
      expect(
        screen.getByRole('combobox', { name: 'Base branch' })
      ).toHaveTextContent('main')
    })

    it('unstars a starred branch', async () => {
      mocks.favoriteBaseBranches = ['project-1:v4.x', 'other:main']
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.click(screen.getByRole('combobox', { name: 'Base branch' }))
      await user.click(screen.getByRole('button', { name: 'Unstar v4.x' }))

      expect(mocks.patchPreferences).toHaveBeenCalledWith({
        favorite_base_branches: ['other:main'],
      })
    })

    it('sorts starred branches to the top of the list', async () => {
      mocks.favoriteBaseBranches = ['project-1:v4.x', 'project-1:release/1.0']
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.click(screen.getByRole('combobox', { name: 'Base branch' }))
      const listbox = await screen.findByRole('listbox')
      const options = within(listbox)
        .getAllByRole('option')
        .map(el => el.textContent?.replace(/^(Un)?[Ss]tar .*$/, '').trim())

      // Starred first (alpha among stars), then the rest alpha
      expect(options[0]).toContain('release/1.0')
      expect(options[1]).toContain('v4.x')
      expect(options.slice(2).join(' ')).toMatch(/develop/)
      expect(options.slice(2).join(' ')).toMatch(/main/)
    })
  })

  describe('several remotes', () => {
    it('shows one create action per remote instead of the generic one', () => {
      renderTab({ remotes: twoRemotes })

      expect(screen.getByText('origin/main')).toBeInTheDocument()
      expect(screen.getByText('fork/main')).toBeInTheDocument()
      expect(
        screen.getByText('New worktree from coollabsio/jean')
      ).toBeInTheDocument()
      expect(
        screen.getByText('New worktree from fsioni/jean')
      ).toBeInTheDocument()
      expect(screen.queryByText('New Worktree')).not.toBeInTheDocument()
    })

    it('creates from the selected remote base branch', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.click(screen.getByText('fork/main'))
      expect(onCreateWorktree).toHaveBeenCalledWith(undefined, 'fork/main')

      await user.click(screen.getByText('origin/main'))
      expect(onCreateWorktree).toHaveBeenLastCalledWith(
        undefined,
        'origin/main'
      )
    })

    it('applies a chosen base branch to each remote action', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.click(screen.getByRole('combobox', { name: 'Base branch' }))
      await user.click(await screen.findByRole('option', { name: /develop/ }))

      expect(screen.getByText('origin/develop')).toBeInTheDocument()
      expect(screen.getByText('fork/develop')).toBeInTheDocument()

      await user.click(screen.getByText('fork/develop'))
      expect(onCreateWorktree).toHaveBeenCalledWith(undefined, 'fork/develop')
    })

    it('shares the custom branch name across both remotes', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.type(screen.getByLabelText('Branch name'), 'hotfix')
      await user.click(screen.getByText('fork/main'))

      expect(onCreateWorktree).toHaveBeenCalledWith('hotfix', 'fork/main')
    })

    it('creates from the first remote when pressing Enter in the name field', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.type(screen.getByLabelText('Branch name'), 'hotfix{Enter}')

      expect(onCreateWorktree).toHaveBeenCalledWith('hotfix', 'origin/main')
    })

    it('rejects invalid branch names', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.type(screen.getByLabelText('Branch name'), 'bad name')
      expect(screen.getByText('Invalid branch name')).toBeInTheDocument()

      await user.click(screen.getByText('fork/main'))
      expect(onCreateWorktree).not.toHaveBeenCalled()
    })

    it('keeps the base session reachable as a secondary action', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes, hasBaseSession: true })

      await user.click(
        screen.getByRole('button', { name: /Switch to Base Session/ })
      )
      expect(onBaseSession).toHaveBeenCalled()
    })

    it('falls back to the generic action when no base branch can be resolved', () => {
      renderTab({
        remotes: twoRemotes,
        defaultBranch: undefined,
        branches: [],
      })

      expect(screen.getByText('New Worktree')).toBeInTheDocument()
      expect(screen.queryByText('origin/main')).not.toBeInTheDocument()
    })

    it('uses the first available branch when the project default is unknown', () => {
      renderTab({ remotes: twoRemotes, defaultBranch: undefined })

      // sampleBranches[0] is develop — multi-remote cards still appear.
      expect(screen.getByText('origin/develop')).toBeInTheDocument()
      expect(screen.getByText('fork/develop')).toBeInTheDocument()
      expect(screen.queryByText('New Worktree')).not.toBeInTheDocument()
    })
  })
})
