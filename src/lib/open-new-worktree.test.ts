import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openNewWorktree } from './open-new-worktree'

const mocks = vi.hoisted(() => ({
  selectProject: vi.fn(),
  setDefaultTab: vi.fn(),
  setOpen: vi.fn(),
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: {
    getState: () => ({ selectProject: mocks.selectProject }),
  },
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      setNewWorktreeModalDefaultTab: mocks.setDefaultTab,
      setNewWorktreeModalOpen: mocks.setOpen,
    }),
  },
}))

describe('openNewWorktree', () => {
  beforeEach(() => vi.clearAllMocks())

  it('selects the project before opening the prompt-first composer', () => {
    openNewWorktree({ projectId: 'project-1' })

    expect(mocks.selectProject).toHaveBeenCalledWith('project-1')
    expect(mocks.setDefaultTab).toHaveBeenCalledWith(null)
    expect(mocks.setOpen).toHaveBeenCalledWith(true)
    const [selectOrder] = mocks.selectProject.mock.invocationCallOrder
    const [openOrder] = mocks.setOpen.mock.invocationCallOrder
    expect(selectOrder).toBeDefined()
    expect(openOrder).toBeDefined()
    expect(selectOrder as number).toBeLessThan(openOrder as number)
  })

  it.each([
    'issues',
    'prs',
    'security',
    'branches',
    'linear',
    'sentry',
  ] as const)(
    'opens the %s browser through the same modal',
    tab => {
      openNewWorktree({ projectId: 'project-1', tab })

      expect(mocks.selectProject).toHaveBeenCalledWith('project-1')
      expect(mocks.setDefaultTab).toHaveBeenCalledWith(tab)
      expect(mocks.setOpen).toHaveBeenCalledWith(true)
    }
  )
})
