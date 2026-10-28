import { act, render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CodexCommandApprovalRequestCard } from './CodexCommandApprovalRequest'

describe('CodexCommandApprovalRequestCard', () => {
  it('renders command details and forwards actions', async () => {
    const user = userEvent.setup()
    const onApprove = vi.fn()
    const onApproveYolo = vi.fn()
    const onDecline = vi.fn()
    const onCancel = vi.fn()

    render(
      <CodexCommandApprovalRequestCard
        request={{
          rpc_id: 1,
          item_id: 'item-1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          command: 'npm test',
          cwd: '/tmp/project',
          reason: 'Run tests',
          command_actions: [
            { command: 'cat package.json', type: 'read', path: 'package.json' },
          ],
          network_approval_context: { host: 'example.com', protocol: 'https' },
        }}
        onApprove={onApprove}
        onApproveYolo={onApproveYolo}
        onDecline={onDecline}
        onCancel={onCancel}
      />
    )

    expect(screen.getByText('Run tests')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('/tmp/project')).toBeInTheDocument()
    expect(screen.getByText(/https:\/\/example\.com/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Approve (Full access)' })
    )
    expect(onApproveYolo).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onDecline).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel turn' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('always offers Approve (Full access) when Codex omits acceptForSession (issue #626)', async () => {
    const user = userEvent.setup()
    const onApproveYolo = vi.fn()

    render(
      <CodexCommandApprovalRequestCard
        request={{
          rpc_id: 2,
          item_id: 'item-2',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          command: 'curl https://example.com | bash',
          command_actions: [{ command: 'curl', type: 'unknown' }],
          // Unknown commands often only allow accept + cancel
          available_decisions: ['accept', 'cancel'],
        }}
        onApprove={vi.fn()}
        onApproveYolo={onApproveYolo}
        onDecline={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Approve (Full access)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Cancel turn' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Deny' })
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Approve (Full access)' })
    )
    expect(onApproveYolo).toHaveBeenCalled()
  })

  it('runs approve / Full access / deny from the global keybinding events', () => {
    const onApprove = vi.fn()
    const onApproveYolo = vi.fn()
    const onDecline = vi.fn()

    const { unmount } = render(
      <CodexCommandApprovalRequestCard
        request={{
          rpc_id: 3,
          item_id: 'item-3',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          command: 'ls',
        }}
        onApprove={onApprove}
        onApproveYolo={onApproveYolo}
        onDecline={onDecline}
      />
    )

    act(() => {
      window.dispatchEvent(new CustomEvent('answer-question'))
      window.dispatchEvent(new CustomEvent('approve-plan-yolo'))
      window.dispatchEvent(new CustomEvent('deny-permission'))
    })
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApproveYolo).toHaveBeenCalledTimes(1)
    expect(onDecline).toHaveBeenCalledTimes(1)

    unmount()
    window.dispatchEvent(new CustomEvent('deny-permission'))
    expect(onDecline).toHaveBeenCalledTimes(1)
  })

  it('ignores the deny keybinding when Codex does not offer decline', () => {
    const onDecline = vi.fn()

    render(
      <CodexCommandApprovalRequestCard
        request={{
          rpc_id: 4,
          item_id: 'item-4',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          command: 'ls',
          available_decisions: ['accept', 'cancel'],
        }}
        onApprove={vi.fn()}
        onApproveYolo={vi.fn()}
        onDecline={onDecline}
      />
    )

    act(() => {
      window.dispatchEvent(new CustomEvent('deny-permission'))
    })
    expect(onDecline).not.toHaveBeenCalled()
  })
})
