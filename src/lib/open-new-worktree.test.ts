import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openNewWorktree } from './open-new-worktree'

const mocks = vi.hoisted(() => ({
  selectProject: vi.fn(),
  setDefaultTab: vi.fn(),
  setOpen: vi.fn(),
  setLeftSidebarVisible: vi.fn(),
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
      setLeftSidebarVisible: mocks.setLeftSidebarVisible,
    }),
  },
}))

describe('openNewWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    })
  })

  it('closes the mobile sidebar before opening the composer', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })

    openNewWorktree({ projectId: 'project-1' })

    expect(mocks.setLeftSidebarVisible).toHaveBeenCalledWith(false)
    const [closeSidebarOrder] =
      mocks.setLeftSidebarVisible.mock.invocationCallOrder
    const [openComposerOrder] = mocks.setOpen.mock.invocationCallOrder
    expect(closeSidebarOrder as number).toBeLessThan(
      openComposerOrder as number
    )
  })

  it('keeps the desktop sidebar visible', () => {
    openNewWorktree({ projectId: 'project-1' })

    expect(mocks.setLeftSidebarVisible).not.toHaveBeenCalled()
  })

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
