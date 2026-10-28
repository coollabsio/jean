import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import { SidebarTabs } from './SidebarTabs'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

const mocks = vi.hoisted(() => ({ isMobile: false, agentsEnabled: true }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { agents_enabled: mocks.agentsEnabled },
  }),
}))

const tabNames = () => screen.getAllByRole('tab').map(tab => tab.textContent)
const selectedTab = () =>
  screen
    .getAllByRole('tab')
    .find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent

describe('SidebarTabs', () => {
  beforeEach(() => {
    mocks.isMobile = false
    mocks.agentsEnabled = true
    useProjectsStore.setState({ sidebarActiveTab: 'projects' })
    useUIStore.setState({
      leftSidebarVisible: true,
      preferencesOpen: false,
      railSection: 'workspace',
    })
  })

  it('joins Projects, Recent and Agents in one strip', () => {
    render(<SidebarTabs />)

    expect(tabNames()).toEqual(['Projects', 'Recent', 'Agents'])
    expect(selectedTab()).toBe('Projects')
  })

  it('hides Agents and falls back to the workspace tab when agents are off', () => {
    mocks.agentsEnabled = false
    useProjectsStore.setState({ sidebarActiveTab: 'recent' })
    useUIStore.setState({ railSection: 'agents' })
    render(<SidebarTabs />)

    expect(tabNames()).toEqual(['Projects', 'Recent'])
    expect(selectedTab()).toBe('Recent')
  })

  it('switches to Agents and keeps the sidebar open', async () => {
    render(<SidebarTabs />)
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }))

    expect(useUIStore.getState().railSection).toBe('agents')
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(selectedTab()).toBe('Agents')
  })

  it('leaves Agents for the chosen workspace tab', async () => {
    useUIStore.setState({ railSection: 'agents' })
    render(<SidebarTabs />)
    await userEvent.click(screen.getByRole('tab', { name: 'Recent' }))

    expect(useUIStore.getState().railSection).toBe('workspace')
    expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
    expect(selectedTab()).toBe('Recent')
  })

  it('suppresses the webview context menu on the strip', () => {
    render(<SidebarTabs />)
    const tab = screen.getByRole('tab', { name: 'Projects' })

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
