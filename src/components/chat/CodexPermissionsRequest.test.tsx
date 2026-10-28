import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CodexPermissionsRequest } from './CodexPermissionsRequest'

describe('CodexPermissionsRequest', () => {
  it('renders requested permissions and forwards approve/deny actions', async () => {
    const user = userEvent.setup()
    const onGrant = vi.fn()
    const onDecline = vi.fn()

    render(
      <CodexPermissionsRequest
        request={{
          rpc_id: 1,
          item_id: 'item-1',
          reason: 'Need to write a file',
          permissions: {
            fileSystem: { read: ['/tmp/readme'], write: ['/tmp/output'] },
            network: { enabled: true },
          },
        }}
        onGrant={onGrant}
        onDecline={onDecline}
      />
    )

    expect(screen.getByText('Need to write a file')).toBeInTheDocument()
    expect(screen.getByText('/tmp/readme')).toBeInTheDocument()
    expect(screen.getByText('/tmp/output')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /approve for session/i })
    )
    expect(onGrant).toHaveBeenCalledWith('session')

    await user.click(screen.getByRole('button', { name: /deny/i }))
    expect(onDecline).toHaveBeenCalled()
  })
})
