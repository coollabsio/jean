import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { ScriptsButton } from './ScriptsButton'

const mocks = vi.hoisted(() => ({
  scripts: [
    { name: 'dev', command: 'pnpm', args: ['run', 'dev'] },
    { name: 'test:unit', command: 'pnpm', args: ['run', 'test:unit'] },
  ],
  favoritePackageScripts: ['other-project:lint', 'project-1:test:unit'],
  patchPreferences: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  usePackageScripts: () => ({ data: mocks.scripts }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { favorite_package_scripts: mocks.favoritePackageScripts },
  }),
  usePatchPreferences: () => ({ mutate: mocks.patchPreferences }),
}))

describe('ScriptsButton', () => {
  beforeEach(() => {
    mocks.scripts = [
      { name: 'dev', command: 'pnpm', args: ['run', 'dev'] },
      { name: 'test:unit', command: 'pnpm', args: ['run', 'test:unit'] },
    ]
    mocks.favoritePackageScripts = ['other-project:lint', 'project-1:test:unit']
    mocks.patchPreferences.mockReset()
  })

  it('lists package.json scripts and runs the selected script', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(
      <ScriptsButton projectId="project-1" worktreePath="/repo" onRun={onRun} />
    )

    await user.click(screen.getByRole('button', { name: 'Scripts' }))
    await user.click(screen.getByRole('menuitem', { name: 'test:unit' }))

    expect(onRun).toHaveBeenCalledWith(mocks.scripts[1])
  })

  it('uses the same muted styling as the neighboring toolbar buttons', () => {
    render(
      <ScriptsButton
        projectId="project-1"
        worktreePath="/repo"
        onRun={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Scripts' })).toHaveClass(
      'border-border/50',
      'bg-muted/50',
      'text-muted-foreground'
    )
  })

  it('is hidden when package.json has no scripts', () => {
    mocks.scripts = []
    render(
      <ScriptsButton
        projectId="project-1"
        worktreePath="/repo"
        onRun={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Scripts' })).toBeNull()
  })

  it('allows package scripts to be favorited from the desktop menu', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(
      <ScriptsButton projectId="project-1" worktreePath="/repo" onRun={onRun} />
    )

    await user.click(screen.getByRole('button', { name: 'Scripts' }))

    const menu = screen.getByRole('menu')
    const favoriteButtons = within(menu).getAllByRole('button', {
      name: /favorite/i,
    })
    expect(
      favoriteButtons.map(button => button.getAttribute('aria-label'))
    ).toEqual(['Unfavorite test:unit', 'Favorite dev'])
    expect(favoriteButtons[0]?.querySelector('svg')).toHaveClass(
      'fill-yellow-500',
      'text-yellow-500'
    )

    await user.click(within(menu).getByRole('button', { name: 'Favorite dev' }))

    expect(mocks.patchPreferences).toHaveBeenCalledWith({
      favorite_package_scripts: [
        'other-project:lint',
        'project-1:test:unit',
        'project-1:dev',
      ],
    })
    expect(onRun).not.toHaveBeenCalled()
  })
})
