import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import { QueuedPromptsPanel } from './QueuedPromptsPanel'
import type { QueuedMessage } from '@/types/chat'

const createMessage = (
  id: string,
  message: string,
  overrides?: Partial<QueuedMessage>
): QueuedMessage => ({
  id,
  message,
  pendingImages: [],
  pendingFiles: [],
  pendingSkills: [],
  pendingTextFiles: [],
  model: 'sonnet',
  provider: null,
  executionMode: 'plan',
  thinkingLevel: 'off',
  queuedAt: 0,
  ...overrides,
})

describe('QueuedPromptsPanel', () => {
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  const messages = [
    createMessage('msg-1', 'First prompt'),
    createMessage('msg-2', 'Second prompt'),
    createMessage('msg-3', 'Third prompt'),
  ]

  const renderPanel = (overrides?: {
    messages?: QueuedMessage[]
    onRemove?: (sessionId: string, messageId: string) => void
    onSendNow?: (sessionId: string, messageId: string) => void
    onEdit?: (sessionId: string, messageId: string, message: string) => void
  }) => {
    const onRemove = overrides?.onRemove ?? vi.fn()
    const onSendNow = overrides?.onSendNow ?? vi.fn()
    const onEdit = overrides?.onEdit ?? vi.fn()
    const result = render(
      <QueuedPromptsPanel
        sessionId="session-1"
        messages={overrides?.messages ?? messages}
        isSessionBusy={false}
        onRemove={onRemove}
        onSendNow={onSendNow}
        onEdit={onEdit}
      />
    )
    return { ...result, onRemove, onSendNow, onEdit }
  }

  it('renders count badge and all queued prompts', () => {
    renderPanel()

    expect(screen.getByText('Queued prompts')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('First prompt')).toBeInTheDocument()
    expect(screen.getByText('Second prompt')).toBeInTheDocument()
    expect(screen.getByText('Third prompt')).toBeInTheDocument()
  })

  it('renders nothing when the queue is empty', () => {
    renderPanel({ messages: [] })

    expect(screen.queryByText('Queued prompts')).not.toBeInTheDocument()
  })

  it('moves selection with ArrowDown/ArrowUp', () => {
    renderPanel()
    const list = screen.getByRole('list', { name: 'Queued prompts' })

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveAttribute('aria-current', 'true')

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(screen.getAllByRole('listitem')[1]).toHaveAttribute(
      'aria-current',
      'true'
    )

    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('clamps selection at list bounds', () => {
    renderPanel()
    const list = screen.getByRole('list', { name: 'Queued prompts' })

    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute(
      'aria-current',
      'true'
    )

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(screen.getAllByRole('listitem')[2]).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('sends the selected prompt with Enter', () => {
    const { onSendNow } = renderPanel()
    const list = screen.getByRole('list', { name: 'Queued prompts' })

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })

    expect(onSendNow).toHaveBeenCalledWith('session-1', 'msg-2')
  })

  it('removes the selected prompt with Backspace', () => {
    const { onRemove } = renderPanel()
    const list = screen.getByRole('list', { name: 'Queued prompts' })

    fireEvent.keyDown(list, { key: 'Backspace' })

    expect(onRemove).toHaveBeenCalledWith('session-1', 'msg-1')
  })

  it('clamps selection when the queue shrinks', () => {
    const { rerender, onSendNow } = renderPanel()
    const list = screen.getByRole('list', { name: 'Queued prompts' })

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })

    rerender(
      <QueuedPromptsPanel
        sessionId="session-1"
        messages={messages.slice(0, 1)}
        isSessionBusy={false}
        onRemove={vi.fn()}
        onSendNow={onSendNow}
        onEdit={vi.fn()}
      />
    )

    fireEvent.keyDown(
      screen.getByRole('list', { name: 'Queued prompts' }),
      { key: 'Enter' }
    )
    expect(onSendNow).toHaveBeenCalledWith('session-1', 'msg-1')
  })

  it('collapses the panel with Escape', () => {
    renderPanel()
    const list = screen.getByRole('list', { name: 'Queued prompts' })

    fireEvent.keyDown(list, { key: 'Escape' })

    expect(
      screen.queryByRole('list', { name: 'Queued prompts' })
    ).not.toBeInTheDocument()
    // Header stays visible
    expect(screen.getByText('Queued prompts')).toBeInTheDocument()
  })

  it('row buttons call onRemove and onSendNow', () => {
    const { onRemove, onSendNow } = renderPanel()

    const removeButtons = screen.getAllByLabelText('Remove from queue')
    const sendButtons = screen.getAllByLabelText('Send now')
    const secondRemove = removeButtons[1]
    const thirdSend = sendButtons[2]
    expect(secondRemove).toBeDefined()
    expect(thirdSend).toBeDefined()

    fireEvent.click(secondRemove as HTMLElement)
    expect(onRemove).toHaveBeenCalledWith('session-1', 'msg-2')

    fireEvent.click(thirdSend as HTMLElement)
    expect(onSendNow).toHaveBeenCalledWith('session-1', 'msg-3')
  })

  it('edits queued prompts when steering is not supported', () => {
    const { onEdit } = renderPanel()

    const editButton = screen.getAllByLabelText('Edit queued prompt')[0]
    expect(editButton).toBeDefined()
    fireEvent.click(editButton as HTMLElement)
    const editor = screen.getByLabelText('Queued prompt text')
    fireEvent.change(editor, { target: { value: 'Updated prompt' } })
    fireEvent.click(screen.getByLabelText('Save queued prompt'))

    expect(onEdit).toHaveBeenCalledWith('session-1', 'msg-1', 'Updated prompt')
  })

  it('allows editing prompts that remain queued for steerable backends', () => {
    renderPanel({
      messages: [
        createMessage('msg-1', 'Codex prompt', {
          backend: 'codex',
        } as Partial<QueuedMessage>),
        createMessage('msg-2', 'OpenCode prompt', {
          backend: 'opencode',
        } as Partial<QueuedMessage>),
        createMessage('msg-3', 'Grok prompt', {
          backend: 'grok',
        } as Partial<QueuedMessage>),
      ],
    })

    expect(screen.getAllByLabelText('Edit queued prompt')).toHaveLength(3)
  })

  it('allows editing queued prompts for the non-steerable Antigravity backend', () => {
    const { onEdit } = renderPanel({
      messages: [
        createMessage('msg-1', 'Antigravity prompt', {
          backend: 'antigravity',
        } as Partial<QueuedMessage>),
      ],
    })

    const editButton = screen.getByLabelText('Edit queued prompt')
    fireEvent.click(editButton)
    const editor = screen.getByLabelText('Queued prompt text')
    fireEvent.change(editor, { target: { value: 'Updated antigravity' } })
    fireEvent.click(screen.getByLabelText('Save queued prompt'))

    expect(onEdit).toHaveBeenCalledWith(
      'session-1',
      'msg-1',
      'Updated antigravity'
    )
  })

  it('allows editing queued steering prompts with file @-mentions', () => {
    renderPanel({
      messages: [
        createMessage('msg-1', 'Pi prompt', {
          backend: 'pi',
          pendingFiles: [
            {
              id: 'file-1',
              relativePath: 'file.txt',
              extension: 'txt',
              isDirectory: false,
            },
          ],
        } as Partial<QueuedMessage>),
      ],
    })

    expect(screen.getByLabelText('Edit queued prompt')).toBeInTheDocument()
  })

  it('allows editing queued steering prompts with pasted images', () => {
    renderPanel({
      messages: [
        createMessage('msg-1', 'Grok prompt', {
          backend: 'grok',
          pendingImages: [
            { id: 'img-1', path: '/tmp/a.png', filename: 'a.png' },
          ],
        } as Partial<QueuedMessage>),
      ],
    })

    expect(screen.getByLabelText('Edit queued prompt')).toBeInTheDocument()
  })
})
