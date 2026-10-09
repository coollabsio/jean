import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ProjectsSidebar } from './ProjectsSidebar'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  isMobile: false,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: [], isLoading: false, isError: false }),
  useCreateFolder: () => ({ mutate: mocks.createFolder, isPending: false }),
  useRemoveServerProject: () => ({ mutate: vi.fn() }),
  openServerProject: vi.fn(),
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: [] }),
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/components/layout/SidebarWidthContext', () => ({
  useSidebarWidth: () => 280,
}))
vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () => new Map(),
}))
vi.mock('@/lib/environment', () => ({ isNativeApp: () => false }))
vi.mock('./ProjectTree', () => ({ ProjectTree: () => null }))
vi.mock('./RecentWorktreesList', () => ({ RecentWorktreesList: () => null }))

describe('ProjectsSidebar folder creation', () => {
  beforeEach(() => {
    mocks.createFolder.mockReset()
    mocks.isMobile = false
  })

  it('shows a close button only on mobile, which hides the sidebar', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ProjectsSidebar />)
    expect(
      screen.queryByRole('button', { name: 'Close sidebar' })
    ).not.toBeInTheDocument()
    unmount()

    mocks.isMobile = true
    useUIStore.setState({ leftSidebarVisible: true })
    render(<ProjectsSidebar />)
    await user.click(screen.getByRole('button', { name: 'Close sidebar' }))
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })

  it('offers New folder in the search-row plus menu', async () => {
    const user = userEvent.setup()
    render(<ProjectsSidebar />)

    const search = screen.getByRole('searchbox', {
      name: 'Search projects, worktrees and servers',
    })
    await user.type(search, 'old search')
    await user.click(
      screen.getByRole('button', { name: 'Add project, folder or server' })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Add project' })
    ).toHaveAttribute('data-disabled')
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }))

    expect(mocks.createFolder).toHaveBeenCalledWith({ name: 'New Folder' })
    expect(search).toHaveValue('')
  })

  it('opens the server dialog from the plus menu', async () => {
    const user = userEvent.setup()
    useProjectsStore.setState({ serverDialog: null })
    render(<ProjectsSidebar />)

    await user.click(
      screen.getByRole('button', { name: 'Add project, folder or server' })
    )
    await user.click(screen.getByRole('menuitem', { name: 'Add server' }))

    expect(useProjectsStore.getState().serverDialog).toEqual({})
  })
})
