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
    useUIStore.setState({
      leftSidebarVisible: true,
      preferencesOpen: false,
      railSection: 'workspace',
    })
  })

  it('shows Workspace and Agents sections', () => {
    render(<SidebarTabRail />)

    expect(screen.getAllByRole('tab')).toHaveLength(2)
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

  it('hides a visible sidebar and keeps Workspace active', async () => {
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(
      screen
        .getByRole('tab', { name: 'Workspace' })
        .getAttribute('aria-selected')
    ).toBe('true')
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

  it('switches to Agents without hiding the desktop sidebar state', async () => {
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }))

    expect(useUIStore.getState().railSection).toBe('agents')
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(
      screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')
    ).toBe('true')
    expect(
      screen
        .getByRole('tab', { name: 'Workspace' })
        .getAttribute('aria-selected')
    ).toBe('false')
  })

  it('returns to Workspace and shows the sidebar from Agents', async () => {
    useUIStore.setState({ railSection: 'agents', leftSidebarVisible: false })
    render(<SidebarTabRail togglesSidebar />)
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

    expect(useUIStore.getState().railSection).toBe('workspace')
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('closes the mobile drawer when Agents is clicked', async () => {
    mocks.isMobile = true
    render(<SidebarTabRail />)
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }))

    expect(useUIStore.getState().railSection).toBe('agents')
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })
})
