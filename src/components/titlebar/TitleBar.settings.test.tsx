import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { TitleBar } from './TitleBar'
import { useUIStore } from '@/store/ui-store'

const mocks = vi.hoisted(() => ({ isMobile: false }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))
vi.mock('./UpdatesIndicator', () => ({ UpdatesIndicator: () => null }))
vi.mock('@/components/unread/UnreadBell', () => ({ UnreadBell: () => null }))

describe('TitleBar Settings gear', () => {
  beforeEach(() => {
    mocks.isMobile = false
    useUIStore.setState({ zenMode: false, preferencesOpen: false })
  })

  it('opens Settings from the title bar', async () => {
    render(<TitleBar />)

    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }))

    expect(useUIStore.getState().preferencesOpen).toBe(true)
  })

  it('hides the gear in zen mode', () => {
    useUIStore.setState({ zenMode: true })
    render(<TitleBar />)

    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
  })
})
