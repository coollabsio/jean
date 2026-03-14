import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IntegrationsPane } from './IntegrationsPane'

const mutate = vi.fn()
const usePreferencesMock = vi.fn()

vi.mock('@/services/preferences', () => ({
  usePreferences: () => usePreferencesMock(),
  usePatchPreferences: vi.fn(() => ({
    mutate,
    isPending: false,
  })),
}))

describe('IntegrationsPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePreferencesMock.mockReturnValue({
      data: {
        linear_api_key: null,
        rtk_ai_enabled: true,
        use_rtk_for_claude: true,
        use_rtk_for_codex: false,
        use_rtk_for_opencode: true,
      },
    })
  })

  it('renders RTK toggles', () => {
    render(<IntegrationsPane />)

    expect(screen.getByText('Use RTK with Claude')).toBeInTheDocument()
    expect(screen.getByText('Use RTK with Codex')).toBeInTheDocument()
    expect(screen.getByText('Use RTK with OpenCode')).toBeInTheDocument()
  })

  it('hides RTK settings when global RTK is disabled', () => {
    usePreferencesMock.mockReturnValue({
      data: {
        linear_api_key: null,
        rtk_ai_enabled: false,
        use_rtk_for_claude: true,
        use_rtk_for_codex: false,
        use_rtk_for_opencode: true,
      },
    })

    render(<IntegrationsPane />)

    expect(screen.queryByText('Use RTK with Claude')).not.toBeInTheDocument()
    expect(screen.queryByText('Use RTK with Codex')).not.toBeInTheDocument()
    expect(screen.queryByText('Use RTK with OpenCode')).not.toBeInTheDocument()
  })

  it('patches preferences when RTK toggles change', async () => {
    const user = userEvent.setup()
    render(<IntegrationsPane />)

    const switches = screen.getAllByRole('switch')
    await user.click(switches[0]!)
    await user.click(switches[1]!)
    await user.click(switches[2]!)

    expect(mutate).toHaveBeenNthCalledWith(1, { use_rtk_for_claude: false })
    expect(mutate).toHaveBeenNthCalledWith(2, { use_rtk_for_codex: true })
    expect(mutate).toHaveBeenNthCalledWith(3, { use_rtk_for_opencode: false })
  })
})
