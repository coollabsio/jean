import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExperimentalPane } from './ExperimentalPane'

const mutate = vi.fn()

vi.mock('@/services/preferences', () => ({
  usePreferences: vi.fn(() => ({
    data: {
      rtk_ai_enabled: false,
      parallel_execution_prompt_enabled: false,
      session_recap_enabled: false,
      debug_mode_enabled: false,
      magic_prompt_models: {
        session_recap_model: 'haiku',
      },
    },
  })),
  usePatchPreferences: vi.fn(() => ({
    mutate,
  })),
}))

describe('ExperimentalPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the global RTK AI toggle', () => {
    render(<ExperimentalPane />)

    expect(screen.getByText('Enable RTK AI')).toBeInTheDocument()
  })

  it('patches preferences when the global RTK AI toggle changes', async () => {
    const user = userEvent.setup()
    render(<ExperimentalPane />)

    const switches = screen.getAllByRole('switch')
    await user.click(switches[2]!)

    expect(mutate).toHaveBeenCalledWith({ rtk_ai_enabled: true })
  })
})
