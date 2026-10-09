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

  it('shows a single Workspace section', () => {
    render(<SidebarTabRail />)

    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(
      screen
        .getByRole('tab', { name: 'Workspace' })
        .getAttribute('aria-selected')
    ).toBe('true')
  })

  it('does not hide the mobile drawer when Workspace is clicked', async () => {
    render(<SidebarTabRail />)
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('hides a visible sidebar when Workspace is clicked', async () => {
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(
      screen
        .getByRole('tab', { name: 'Workspace' })
        .getAttribute('aria-selected')
    ).toBe('false')
  })

  it('shows a hidden sidebar and keeps the panel view', async () => {
    useProjectsStore.setState({ sidebarActiveTab: 'recent' })
    useUIStore.setState({ leftSidebarVisible: false })
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

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
