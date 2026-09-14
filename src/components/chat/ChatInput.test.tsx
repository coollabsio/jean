import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { ChatInput } from './ChatInput'
import { invoke } from '@/lib/transport'
import type * as EnvironmentModule from '@/lib/environment'
import { useUIStore } from '@/store/ui-store'
import {
  appendPromptMetadataToPlainText,
  encodePromptAttachmentMetadata,
  type PromptAttachmentMetadata,
} from './message-content-utils'

const processAttachmentFile = vi.fn()
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>
const { mobileState, nativeState, slashPopoverMock } = vi.hoisted(() => ({
  mobileState: { value: false },
  nativeState: { value: false },
  slashPopoverMock: vi.fn(() => null),
}))

const storeState = {
  inputDrafts: {} as Record<string, string>,
  setInputDraft: vi.fn(),
  getPendingFiles: vi.fn(() => []),
  removePendingFile: vi.fn(),
  addPendingFile: vi.fn(),
  addPendingSkill: vi.fn(),
  addPendingImage: vi.fn(),
  addPendingTextFile: vi.fn(),
}

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mobileState.value,
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => nativeState.value,
}))

vi.mock('./attachment-processing', () => ({
  processAttachmentFile: (...args: unknown[]) => processAttachmentFile(...args),
}))

vi.mock('./FileMentionPopover', () => ({
  FileMentionPopover: () => null,
}))

vi.mock('./SlashPopover', () => ({
  SlashPopover: slashPopoverMock,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => storeState,
    subscribe: vi.fn(() => vi.fn()),
  },
}))

describe('ChatInput attachments', () => {
  const renderInput = () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
      />
    )

    return screen.getByRole('textbox') as HTMLTextAreaElement
  }

  beforeEach(() => {
    mobileState.value = false
    nativeState.value = false
    useUIStore.setState({ zenMode: false })
    processAttachmentFile.mockReset()
    invokeMock.mockReset()
    storeState.setInputDraft.mockReset()
    storeState.getPendingFiles.mockReset()
    storeState.getPendingFiles.mockReturnValue([])
    storeState.removePendingFile.mockReset()
    storeState.addPendingFile.mockReset()
    storeState.addPendingSkill.mockReset()
    storeState.addPendingImage.mockReset()
    storeState.addPendingTextFile.mockReset()
    storeState.inputDrafts = {}
    slashPopoverMock.mockClear()
  })

  it('opens the skill picker when typing $ for a Codex session', () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
        selectedBackend="codex"
        installedBackends={['codex']}
      />
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '$', selectionStart: 1 },
    })

    expect(slashPopoverMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        searchQuery: '',
        triggerKind: 'skill',
      }),
      undefined
    )
  })

  it('does not open the skill picker when typing $ for a non-Codex session', () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
        selectedBackend="claude"
        installedBackends={['claude']}
      />
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '$', selectionStart: 1 },
    })

    expect(slashPopoverMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: false }),
      undefined
    )
  })

  it('registers attach handler and forwards selected files to the processor', async () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()
    const attachHandlerRef: { current: (() => void) | null } = {
      current: null,
    }

    const { container } = render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onRegisterAttachHandler={handler => {
          attachHandlerRef.current = handler
        }}
        formRef={formRef}
        inputRef={inputRef}
      />
    )

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    expect(fileInput).toBeInTheDocument()

    const clickSpy = vi.spyOn(fileInput, 'click')
    expect(attachHandlerRef.current).not.toBeNull()
    if (attachHandlerRef.current) {
      attachHandlerRef.current()
    }
    expect(clickSpy).toHaveBeenCalledTimes(1)

    const file = new File(['abc'], 'upload.png', { type: 'image/png' })
    processAttachmentFile.mockResolvedValue(undefined)

    fireEvent.change(fileInput, {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(processAttachmentFile).toHaveBeenCalledWith(file, 'session-1')
    })
  })

  it('renders a shrinkable textarea that wraps long unbroken text', () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="yolo"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
      />
    )

    const textarea = screen.getByRole('textbox')

    expect(textarea).toHaveAttribute('wrap', 'soft')
    expect(textarea).toHaveClass(
      'min-w-0',
      'overflow-x-hidden',
      'whitespace-pre-wrap',
      'break-words'
    )
    expect(textarea.className).toContain('[overflow-wrap:anywhere]')
    expect(textarea.parentElement).toHaveClass('min-w-0')
  })

  it('caps the textarea height in mobile zen mode', () => {
    mobileState.value = true
    useUIStore.setState({ zenMode: true })

    const textarea = renderInput()

    expect(textarea).toHaveClass('h-12', 'max-h-12')
    expect(textarea).not.toHaveClass('max-h-[50vh]')
  })

  it('uses a compact textarea height in desktop zen mode', () => {
    useUIStore.setState({ zenMode: true })

    const textarea = renderInput()

    expect(textarea).toHaveClass('h-12', 'max-h-12')
    expect(textarea).not.toHaveClass('max-h-[50vh]')
    expect(screen.queryByText('to focus')).not.toBeInTheDocument()
  })

  it('uses smaller placeholder text on mobile', () => {
    mobileState.value = true

    const textarea = renderInput()

    expect(textarea).toHaveClass('placeholder:text-sm')
    expect(textarea).toHaveClass('text-base')
  })

  it('updates the session draft store immediately so disk saves can be debounced', () => {
    const textarea = renderInput()

    fireEvent.change(textarea, { target: { value: 'not sent yet' } })

    expect(storeState.setInputDraft).toHaveBeenCalledWith(
      'session-1',
      'not sent yet'
    )
  })

  it('restores attachments from rich copied prompt metadata', async () => {
    const textarea = renderInput()
    const metadata: PromptAttachmentMetadata = {
      v: 1,
      images: ['/tmp/image.png'],
      textFiles: [],
      files: [
        { path: 'src/App.tsx', isDirectory: false },
        { path: 'src/components', isDirectory: true },
      ],
      skills: [{ name: 'foo', path: '/skills/foo/SKILL.md' }],
    }

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? `<span data-jean-prompt="${encodePromptAttachmentMetadata(metadata)}">Check this</span>`
            : type === 'text/plain'
              ? 'Check this'
              : '',
        items: [],
      },
    })

    await waitFor(() => {
      expect(storeState.setInputDraft).toHaveBeenCalledWith(
        'session-1',
        'Check this'
      )
      expect(storeState.addPendingImage).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          path: '/tmp/image.png',
          filename: 'image.png',
        })
      )
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src/App.tsx',
          isDirectory: false,
        })
      )
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src/components',
          isDirectory: true,
        })
      )
      expect(storeState.addPendingSkill).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          name: 'foo',
          path: '/skills/foo/SKILL.md',
        })
      )
    })
  })

  it('restores attachments from plain-text copied prompt fallback', async () => {
    const textarea = renderInput()
    const metadata: PromptAttachmentMetadata = {
      v: 1,
      images: ['/tmp/image.png'],
      textFiles: [],
      files: [{ path: 'src/components', isDirectory: true }],
      skills: [],
    }
    const copiedText = appendPromptMetadataToPlainText('Check this', metadata)

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? copiedText : ''),
        items: [],
      },
    })

    await waitFor(() => {
      expect(storeState.setInputDraft).toHaveBeenCalledWith(
        'session-1',
        'Check this'
      )
      expect(storeState.addPendingImage).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ path: '/tmp/image.png' })
      )
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src/components',
          isDirectory: true,
        })
      )
    })

    expect(textarea.value).toBe('Check this')
  })

  it('preserves both image and small text when pasted together', async () => {
    const textarea = renderInput()
    const image = new File(['png'], 'clip.png', { type: 'image/png' })
    processAttachmentFile.mockResolvedValue(undefined)

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/plain' ? 'caption text' : '',
        items: [
          {
            type: 'image/png',
            getAsFile: () => image,
          },
        ],
      },
    })

    await waitFor(() => {
      expect(processAttachmentFile).toHaveBeenCalledWith(image, 'session-1')
      expect(storeState.setInputDraft).toHaveBeenCalledWith(
        'session-1',
        'caption text'
      )
    })
    expect(textarea.value).toBe('caption text')
  })

  it('uses clipboard files when iOS omits the image from clipboard items', async () => {
    const textarea = renderInput()
    const image = new File(['png'], 'image.png', { type: 'image/png' })
    processAttachmentFile.mockResolvedValue(undefined)

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: () => '',
        items: [],
        files: [image],
      },
    })

    await waitFor(() => {
      expect(processAttachmentFile).toHaveBeenCalledWith(image, 'session-1')
    })
    expect(invokeMock).not.toHaveBeenCalledWith('read_clipboard_image')
  })

  it('does not request the desktop clipboard for an empty web paste', async () => {
    const textarea = renderInput()

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: () => '',
        items: [],
        files: [],
      },
    })

    await waitFor(() => {
      expect(invokeMock).not.toHaveBeenCalledWith('read_clipboard_image')
    })
  })

  it('saves large text as an attachment when pasted with an image', async () => {
    const textarea = renderInput()
    const image = new File(['png'], 'clip.png', { type: 'image/png' })
    const largeText = 'x'.repeat(2100)
    processAttachmentFile.mockResolvedValue(undefined)
    invokeMock.mockResolvedValue({
      id: 'text-1',
      path: '/tmp/paste.txt',
      filename: 'paste.txt',
      size: largeText.length,
    })

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? largeText : ''),
        items: [
          {
            type: 'image/png',
            getAsFile: () => image,
          },
        ],
      },
    })

    await waitFor(() => {
      expect(processAttachmentFile).toHaveBeenCalledWith(image, 'session-1')
      expect(invokeMock).toHaveBeenCalledWith('save_pasted_text', {
        content: largeText,
      })
      expect(storeState.addPendingTextFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          id: 'text-1',
          path: '/tmp/paste.txt',
          content: largeText,
        })
      )
    })
    expect(textarea.value).toBe('')
  })
})

describe('ChatInput IME composition (issue #584)', () => {
  beforeEach(() => {
    processAttachmentFile.mockReset()
    invokeMock.mockReset()
    storeState.setInputDraft.mockReset()
    storeState.getPendingFiles.mockReset()
    storeState.getPendingFiles.mockReturnValue([])
    storeState.removePendingFile.mockReset()
    storeState.addPendingFile.mockReset()
    storeState.addPendingSkill.mockReset()
    storeState.addPendingImage.mockReset()
    storeState.addPendingTextFile.mockReset()
    storeState.inputDrafts = {}
  })

  const renderWithSubmit = (props?: {
    isSending?: boolean
    selectedBackend?: 'codex'
    onSteerModifierChange?: (active: boolean) => void
  }) => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()
    const onSubmit = vi.fn()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={props?.isSending ?? false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
        selectedBackend={props?.selectedBackend}
        onSteerModifierChange={props?.onSteerModifierChange}
      />
    )

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    return { textarea, onSubmit }
  }

  it('submits on normal Enter when not composing', () => {
    const { textarea, onSubmit } = renderWithSubmit()
    textarea.value = 'hello'
    fireEvent.change(textarea, { target: { value: 'hello' } })

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submits as a steer when the primary modifier is held', () => {
    const onSteerModifierChange = vi.fn()
    const { textarea, onSubmit } = renderWithSubmit({
      isSending: true,
      selectedBackend: 'codex',
      onSteerModifierChange,
    })
    textarea.value = 'steer this'
    fireEvent.change(textarea, { target: { value: 'steer this' } })

    fireEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      ctrlKey: true,
    })

    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), {
      forceSteer: true,
    })
    expect(onSteerModifierChange).toHaveBeenCalledWith(true)
  })

  it('submits as a steer when Command+Enter is held', () => {
    const { textarea, onSubmit } = renderWithSubmit({
      isSending: true,
      selectedBackend: 'codex',
    })
    textarea.value = 'steer this'
    fireEvent.change(textarea, { target: { value: 'steer this' } })

    fireEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      metaKey: true,
    })

    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), {
      forceSteer: true,
    })
  })

  it('does not submit when Enter confirms IME composition (isComposing)', () => {
    const { textarea, onSubmit } = renderWithSubmit()
    textarea.value = 'こんにちは'
    fireEvent.change(textarea, { target: { value: 'こんにちは' } })

    fireEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: true,
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('こんにちは')
  })

  it('does not submit on Safari/WKWebView IME Enter (keyCode 229, isComposing false)', () => {
    // compositionend can run before keydown on Safari, so isComposing is
    // already false; keyCode 229 still marks the event as IME-handled.
    const { textarea, onSubmit } = renderWithSubmit()
    textarea.value = '日本語'
    fireEvent.change(textarea, { target: { value: '日本語' } })

    fireEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      isComposing: false,
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('日本語')
  })

  it('submits on the Enter after composition has finished', () => {
    const { textarea, onSubmit } = renderWithSubmit()
    textarea.value = '日本語'
    fireEvent.change(textarea, { target: { value: '日本語' } })

    // Confirm composition (must not submit)
    fireEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      isComposing: false,
    })
    expect(onSubmit).not.toHaveBeenCalled()

    // Second Enter sends the message
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
