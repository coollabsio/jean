import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { SendCancelButton } from './SendCancelButton'

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/platform', () => ({
  getModifierSymbol: () => '⌘',
  isClientMacOS: true,
  isMacOS: true,
}))

describe('SendCancelButton', () => {
  it('renders a generic Send label while idle', () => {
    const { container } = render(
      <SendCancelButton
        isSending={false}
        canSend
        queuedMessageCount={0}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^plan$/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^build$/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^yolo$/i })
    ).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders Cancel while sending without queueing', () => {
    render(
      <SendCancelButton
        isSending
        canSend={false}
        queuedMessageCount={0}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /queue/i })
    ).not.toBeInTheDocument()
  })

  it('renders Queue while sending and another message can be queued', () => {
    const { container } = render(
      <SendCancelButton
        isSending
        canSend
        queuedMessageCount={1}
        onCancel={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: /skip to next/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /queue/i })).toBeInTheDocument()
    expect(screen.getByText('Enter')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^steer$/i })
    ).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders Steer instead of Queue when auto-steer is enabled', () => {
    render(
      <SendCancelButton
        isSending
        canSend
        willSteer
        queuedMessageCount={0}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^steer$/i })).toBeInTheDocument()
    expect(screen.getByText('Enter')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^queue$/i })
    ).not.toBeInTheDocument()
  })

  it('renders the modifier shortcut when steer is temporarily forced', () => {
    render(
      <SendCancelButton
        isSending
        canSend
        willSteer
        steerWithModifier
        queuedMessageCount={0}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /^steer$/i })).toHaveTextContent(
      '⌘↵'
    )
  })

  it('renders the primary send/cancel action before queue or steer', () => {
    render(
      <SendCancelButton
        isSending
        canSend
        queuedMessageCount={0}
        onCancel={vi.fn()}
      />
    )

    const queue = screen.getByRole('button', { name: /^queue$/i })
    const cancel = screen.getByRole('button', { name: /cancel/i })
    expect(
      cancel.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
