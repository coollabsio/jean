import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import {
  getTrimmedSelectionText,
  MessageThreadContextMenu,
  suppressDefaultContextMenu,
} from './message-thread-context-menu'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

describe('getTrimmedSelectionText', () => {
  it('returns trimmed window selection text', () => {
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '  hello world  ',
      }) as Selection

    expect(getTrimmedSelectionText()).toBe('hello world')

    window.getSelection = original
  })

  it('returns empty string when there is no selection', () => {
    const original = window.getSelection
    window.getSelection = () => null

    expect(getTrimmedSelectionText()).toBe('')

    window.getSelection = original
  })
})

describe('suppressDefaultContextMenu', () => {
  it('prevents the default context menu', () => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    suppressDefaultContextMenu(event)
    expect(preventDefault).toHaveBeenCalled()
  })
})

describe('MessageThreadContextMenu', () => {
  beforeEach(() => {
    mocks.copyToClipboard.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.copyToClipboard.mockResolvedValue(undefined)
  })

  it('shows Copy message and copies full text when nothing is selected', async () => {
    const user = userEvent.setup()
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>message body</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('message body'))

    const item = await screen.findByRole('menuitem', { name: /copy message/i })
    await user.click(item)

    await waitFor(() => {
      expect(mocks.copyToClipboard).toHaveBeenCalledWith('Full message body')
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied to clipboard')
    })

    window.getSelection = original
  })

  it('shows Copy for selection and prefers selected text', async () => {
    const user = userEvent.setup()
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => 'selected bit',
      }) as Selection

    render(
      <MessageThreadContextMenu
        messageText="Full message body"
        copyMessageLabel="Copy response"
      >
        <div>message body</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('message body'))

    expect(
      await screen.findByRole('menuitem', { name: /^copy$/i })
    ).toBeVisible()
    expect(
      screen.getByRole('menuitem', { name: /copy response/i })
    ).toBeVisible()

    await user.click(screen.getByRole('menuitem', { name: /^copy$/i }))

    await waitFor(() => {
      expect(mocks.copyToClipboard).toHaveBeenCalledWith('selected bit')
    })

    window.getSelection = original
  })

  it('uses onCopyMessage when provided', async () => {
    const user = userEvent.setup()
    const onCopyMessage = vi.fn().mockResolvedValue(undefined)
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu onCopyMessage={onCopyMessage}>
        <div>user prompt</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('user prompt'))
    await user.click(
      await screen.findByRole('menuitem', { name: /copy message/i })
    )

    expect(onCopyMessage).toHaveBeenCalledTimes(1)
    expect(mocks.copyToClipboard).not.toHaveBeenCalled()

    window.getSelection = original
  })

  it('shows a disabled placeholder when there is nothing to copy', async () => {
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu messageText="   ">
        <div>empty-ish</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('empty-ish'))

    const item = await screen.findByRole('menuitem', {
      name: /no text to copy/i,
    })
    expect(item).toHaveAttribute('data-disabled')

    window.getSelection = original
  })
})
