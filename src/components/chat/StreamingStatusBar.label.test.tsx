import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { StreamingStatusBar } from './StreamingStatusBar'

describe('StreamingStatusBar', () => {
  it('shows only the timer in a normal chat', () => {
    render(<StreamingStatusBar isSending sendStartedAt={Date.now()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(/^\d+s$/)).toBeInTheDocument()
  })

  it('shows "<agent> is working" with the timer in a quiet chat', () => {
    render(
      <StreamingStatusBar
        isSending
        sendStartedAt={Date.now()}
        workingLabel="Release Manager is working"
      />
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Release Manager is working')
    expect(status).toHaveTextContent(/\d+s/)
  })

  it('shows the activity hint instead of the working label', () => {
    render(
      <StreamingStatusBar
        isSending
        sendStartedAt={Date.now()}
        workingLabel="Release Manager is working"
        activityHint="Querying Cloudflare firewall logs"
      />
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Querying Cloudflare firewall logs')
    expect(status).not.toHaveTextContent('Release Manager is working')
  })

  it('renders nothing when no turn runs', () => {
    const { container } = render(
      <StreamingStatusBar
        isSending={false}
        sendStartedAt={null}
        workingLabel="Release Manager is working"
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
