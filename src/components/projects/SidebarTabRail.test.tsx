import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { SidebarTabRail } from './SidebarTabRail'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

const mocks = vi.hoisted(() => ({ isMobile: false }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))

describe('SidebarTabRail', () => {
  beforeEach(() => {
    mocks.isMobile = false
    useProjectsStore.setState({ sidebarActiveTab: 'projects' })
    useUIStore.setState({ leftSidebarVisible: true, preferencesOpen: false })
  })

  it('switches the tab without touching sidebar visibility by default', async () => {
    render(<SidebarTabRail />)
    await userEvent.click(screen.getByRole('tab', { name: 'Recent' }))

    expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('hides the sidebar when the active tab is clicked again', async () => {
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Projects' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(
      screen
        .getByRole('tab', { name: 'Projects' })
        .getAttribute('aria-selected')
    ).toBe('false')
  })

  it('shows a hidden sidebar on the clicked tab', async () => {
    useUIStore.setState({ leftSidebarVisible: false })
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Servers (Beta)' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(useProjectsStore.getState().sidebarActiveTab).toBe('servers')
  })

  it('switches tabs on a visible sidebar without hiding it', async () => {
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Recent' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
  })

  it('opens Settings and keeps the desktop sidebar open', async () => {
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }))

    expect(useUIStore.getState().preferencesOpen).toBe(true)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('closes the mobile drawer when it opens Settings', async () => {
    mocks.isMobile = true
    render(<SidebarTabRail />)
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }))

    expect(useUIStore.getState().preferencesOpen).toBe(true)
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })
})
