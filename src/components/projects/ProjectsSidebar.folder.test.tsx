import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import { ProjectsSidebar } from './ProjectsSidebar'
import { useProjectsStore } from '@/store/projects-store'
import type * as EnvironmentModule from '@/lib/environment'

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
vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => false,
}))
vi.mock('./ProjectTree', () => ({ ProjectTree: () => null }))
vi.mock('./RecentWorktreesList', () => ({ RecentWorktreesList: () => null }))

describe('ProjectsSidebar folder creation', () => {
  beforeEach(() => {
    mocks.createFolder.mockReset()
    mocks.isMobile = false
    useProjectsStore.setState({ addProjectDialogOpen: false })
  })

  it('offers New folder in the search-row plus menu', async () => {
    const user = userEvent.setup()
    render(<ProjectsSidebar />)

    await user.click(
      screen.getByRole('button', { name: 'Add project, server or folder' })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Add project' })
    ).toHaveAttribute('data-disabled')
    expect(
      screen.getAllByRole('menuitem').map(item => item.textContent?.trim())
    ).toEqual(['Add project', 'Add server', 'New folder'])
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }))

    expect(mocks.createFolder).toHaveBeenCalledWith({ name: 'New Folder' })
  })

  it('opens the server dialog from the plus menu', async () => {
    const user = userEvent.setup()
    useProjectsStore.setState({ serverDialog: null })
    render(<ProjectsSidebar />)

    await user.click(
      screen.getByRole('button', { name: 'Add project, server or folder' })
    )
    await user.click(screen.getByRole('menuitem', { name: 'Add server' }))

    expect(useProjectsStore.getState().serverDialog).toEqual({})
  })

  it('suppresses the webview menu on sidebar chrome', () => {
    render(<ProjectsSidebar />)

    const chrome = screen.getByRole('button', {
      name: 'Add project, server or folder',
    })
    expect(
      fireEvent.contextMenu(chrome, { bubbles: true, cancelable: true })
    ).toBe(false)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('offers New project in the empty project list', async () => {
    const user = userEvent.setup()
    render(<ProjectsSidebar />)

    fireEvent.contextMenu(screen.getByText('No projects found'))
    expect(
      screen.queryByRole('menuitem', { name: 'New folder' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'New project' }))

    expect(useProjectsStore.getState().addProjectDialogOpen).toBe(true)
  })
})
