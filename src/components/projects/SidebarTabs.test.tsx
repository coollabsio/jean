import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import { SidebarTabs } from './SidebarTabs'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

const mocks = vi.hoisted(() => ({ isMobile: false }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))

const tabNames = () => screen.getAllByRole('tab').map(tab => tab.textContent)
const selectedTab = () =>
  screen
    .getAllByRole('tab')
    .find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent

describe('SidebarTabs', () => {
  beforeEach(() => {
    mocks.isMobile = false
    useProjectsStore.setState({ sidebarActiveTab: 'projects' })
    useUIStore.setState({
      leftSidebarVisible: true,
      preferencesOpen: false,
    })
  })

  it('joins Workspace and Recent in one strip', () => {
    render(<SidebarTabs />)

    expect(tabNames()).toEqual(['Workspace', 'Recent'])
    expect(selectedTab()).toBe('Workspace')
  })

  it('switches to the chosen workspace tab', async () => {
    render(<SidebarTabs />)
    await userEvent.click(screen.getByRole('tab', { name: 'Recent' }))

    expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
    expect(selectedTab()).toBe('Recent')
  })

  it('suppresses the webview context menu on the strip', () => {
    render(<SidebarTabs />)
    const tab = screen.getByRole('tab', { name: 'Workspace' })

    expect(
      fireEvent.contextMenu(tab, { bubbles: true, cancelable: true })
    ).toBe(false)
  })

  it('keeps Settings and close out of the desktop strip', () => {
    render(<SidebarTabs />)

    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close sidebar' })).toBeNull()
  })

  it('keeps Settings out of the mobile strip', () => {
    mocks.isMobile = true
    render(<SidebarTabs />)

    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
  })

  it('closes the mobile drawer from the close button', async () => {
    mocks.isMobile = true
    render(<SidebarTabs />)
    await userEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))

    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(useUIStore.getState().preferencesOpen).toBe(false)
  })
})
