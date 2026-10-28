import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { SidebarTabRail } from './SidebarTabRail'
import { useUIStore } from '@/store/ui-store'

const mocks = vi.hoisted(() => ({ isMobile: false }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

describe('SidebarTabRail', () => {
  beforeEach(() => {
    mocks.isMobile = false
    useUIStore.setState({ leftSidebarVisible: true, preferencesOpen: false })
  })

  it('holds only the Settings gear, without view tabs or version', () => {
    render(<SidebarTabRail />)

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(
      screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))
    ).toEqual(['Open Settings'])
  })

  it('opens Settings and keeps the desktop sidebar open', async () => {
    render(<SidebarTabRail />)
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }))

    expect(useUIStore.getState().preferencesOpen).toBe(true)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('renders nothing on mobile, where the tab strip holds Settings', () => {
    mocks.isMobile = true
    render(<SidebarTabRail />)

    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
  })
})
