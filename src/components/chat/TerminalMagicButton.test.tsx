import { beforeEach, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { TerminalMagicButton } from './TerminalMagicButton'

describe('TerminalMagicButton', () => {
  beforeEach(() => {
    useUIStore.setState({
      sessionPrimarySurface: {},
      magicModalOpen: false,
    })
  })

  it('renders nothing for a chat session', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'chat')
    render(<TerminalMagicButton sessionId="session-1" />)
    expect(screen.queryByRole('button', { name: 'Magic' })).toBeNull()
  })

  it('renders nothing when there is no session', () => {
    render(<TerminalMagicButton sessionId={null} />)
    expect(screen.queryByRole('button', { name: 'Magic' })).toBeNull()
  })

  it('shows a Magic button for a native CLI session and opens the palette', async () => {
    const user = userEvent.setup()
    useUIStore.getState().setSessionPrimarySurface('session-1', 'terminal')

    render(<TerminalMagicButton sessionId="session-1" />)

    await user.click(screen.getByRole('button', { name: 'Magic' }))
    expect(useUIStore.getState().magicModalOpen).toBe(true)
  })
})
