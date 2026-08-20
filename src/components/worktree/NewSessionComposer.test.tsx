import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getNewWorktreeDraftId, NewSessionComposer } from './NewSessionComposer'
import type * as NewSessionFlow from './new-session-flow'
import { useChatStore } from '@/store/chat-store'

const {
  flowMocks,
  backendState,
  preferenceMocks,
  projectServiceState,
  dragAndDropMocks,
} = vi.hoisted(() => ({
    flowMocks: {
      finish: vi.fn(),
      startPrompt: vi.fn().mockResolvedValue(undefined),
      tracker: {
        waitForCreated: vi.fn(),
        waitForSetup: vi.fn(),
        dispose: vi.fn(),
      },
    },
    backendState: {
      installedBackends: ['claude', 'codex'],
      isLoading: false,
    },
    preferenceMocks: { patch: vi.fn() },
    projectServiceState: { remotes: undefined as undefined | unknown[] },
    dragAndDropMocks: { useDragAndDropImages: vi.fn() },
  }))

vi.mock('@/components/chat/hooks/useDragAndDropImages', () => ({
  useDragAndDropImages: dragAndDropMocks.useDragAndDropImages,
}))

vi.mock('./new-session-flow', async importOriginal => ({
  ...(await importOriginal<typeof NewSessionFlow>()),
  finishNewSessionFlow: flowMocks.finish,
  startNewSessionPrompt: flowMocks.startPrompt,
  prepareWorktreeCreationTracker: vi.fn().mockResolvedValue(flowMocks.tracker),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      default_backend: 'claude',
      default_execution_mode: 'plan',
      custom_cli_profiles: [],
      favorite_base_branches: [],
    },
  }),
  usePatchPreferences: () => ({ mutate: preferenceMocks.patch }),
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => backendState,
}))
vi.mock('@/services/projects', () => ({
  useProjectRemotes: () => ({ data: projectServiceState.remotes }),
  handleNextWorktreeErrorLocally: vi.fn(),
}))
vi.mock('@/components/chat/toolbar/DesktopBackendModelPicker', () => ({
  DesktopBackendModelPicker: ({
    selectedBackend,
    selectedModel,
  }: {
    selectedBackend: string
    selectedModel: string
  }) => (
    <button type="button">
      {selectedBackend}:{selectedModel}
    </button>
  ),
}))
vi.mock('@/components/chat/toolbar/MobileBackendModelPickerSheet', () => ({
  MobileBackendModelPickerSheet: ({ open }: { open: boolean }) =>
    open ? <div>Select Backend &amp; Model</div> : null,
}))
vi.mock('@/components/chat/toolbar/ExecutionModeDropdown', () => ({
  ExecutionModeDropdown: ({ executionMode }: { executionMode: string }) => (
    <button type="button">{executionMode} mode</button>
  ),
}))
vi.mock('@/components/chat/ChatInput', () => {
  return {
    ChatInput: ({
      inputRef,
      onHasValueChange,
      onRegisterAttachHandler,
    }: {
      inputRef: { current: HTMLTextAreaElement | null }
      onHasValueChange: (hasValue: boolean) => void
      onRegisterAttachHandler?: (handler: (() => void) | null) => void
    }) => {
      useEffect(() => {
        onRegisterAttachHandler?.(() => {
          useChatStore
            .getState()
            .addPendingImage(getNewWorktreeDraftId('project-1'), {
              id: 'attached-image',
              path: '/tmp/screenshot.png',
              filename: 'screenshot.png',
            })
        })
        return () => onRegisterAttachHandler?.(null)
      }, [onRegisterAttachHandler])

      return (
        <textarea
          aria-label="Prompt"
          ref={inputRef}
          onChange={event =>
            onHasValueChange(Boolean(event.target.value.trim()))
          }
        />
      )
    },
  }
})

const baseProps = {
  projectId: 'project-1',
  projectName: 'Jean',
  projects: [
    { id: 'project-1', name: 'Jean' },
    { id: 'project-2', name: 'Website' },
  ] as never,
  onSelectProject: vi.fn(),
  projectPath: '/repo',
  defaultBranch: 'main',
  remotes: [],
  branches: ['main', 'develop'],
  isLoadingBranches: false,
  setupScript: null,
  onSelectBase: vi.fn(),
  hasBaseSession: false,
  showConfigureProject: false,
  onConfigureProject: vi.fn(),
  source: null,
  sourceContext: null,
  onClearSourceContext: vi.fn(),
  onCreated: vi.fn(),
  createWorktree: vi.fn(),
  createWorktreeFromBranch: vi.fn(),
  createBaseSession: vi.fn(),
  onOpenTab: vi.fn(),
  onConfigureBackends: vi.fn(),
}

describe('NewSessionComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    })
    useChatStore.setState({ pendingSetupPrompts: {}, pendingSkills: {} })
    HTMLElement.prototype.scrollIntoView = vi.fn()
    backendState.installedBackends = ['claude', 'codex']
    backendState.isLoading = false
    projectServiceState.remotes = undefined
  })

  it('routes dropped images to the modal prompt draft', () => {
    render(<NewSessionComposer {...baseProps} />)

    expect(dragAndDropMocks.useDragAndDropImages).toHaveBeenCalledWith(
      getNewWorktreeDraftId('project-1')
    )
  })

  it('keeps the prompt first while allowing a worktree without a prompt', () => {
    render(<NewSessionComposer {...baseProps} />)

    expect(screen.queryByText('New session')).not.toBeInTheDocument()
    expect(screen.getByText('Jean')).toBeInTheDocument()
    expect(screen.getByText('New worktree from main')).toBeInTheDocument()
    expect(
      screen.queryByTestId('worktree-operation-summary')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Base:')).not.toBeInTheDocument()
    expect(screen.queryByText('Name:')).not.toBeInTheDocument()
    const createButton = screen.getByRole('button', {
      name: /^Create worktree\s*↵$/,
    })
    expect(createButton).toBeEnabled()
    expect(createButton).toHaveTextContent('Create worktree')
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Implement prompt-first sessions' },
    })
    expect(createButton).toBeEnabled()
  })

  it('keeps model selection visible and hides the Enter hint on mobile', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })

    render(<NewSessionComposer {...baseProps} />)

    const modelPicker = screen.getByRole('button', {
      name: 'Choose backend and model',
    })
    expect(modelPicker).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Create worktree' })
    ).not.toHaveTextContent('↵')

    fireEvent.click(modelPicker)
    expect(screen.getByText('Select Backend & Model')).toBeVisible()
  })

  it('shows and removes a skill selected for the new conversation', () => {
    render(<NewSessionComposer {...baseProps} />)

    act(() => {
      useChatStore
        .getState()
        .addPendingSkill(getNewWorktreeDraftId('project-1'), {
          id: 'review-skill',
          name: 'review',
          path: '/skills/review/SKILL.md',
        })
    })

    expect(screen.getByText('/review')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Remove skill' }))
    expect(screen.queryByText('/review')).not.toBeInTheDocument()
  })

  it('lets users switch project from the composer header', () => {
    render(<NewSessionComposer {...baseProps} />)

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose project' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Website/ }))

    expect(baseProps.onSelectProject).toHaveBeenCalledWith('project-2')
  })

  it('filters large project lists from the composer header', () => {
    render(<NewSessionComposer {...baseProps} />)

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose project' })
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), {
      target: { value: 'web' },
    })

    expect(screen.getByRole('menuitem', { name: /Website/ })).toBeVisible()
    expect(
      screen.queryByRole('menuitem', { name: /Jean/ })
    ).not.toBeInTheDocument()
  })

  it('keeps worktree settings available without competing with the prompt', () => {
    render(<NewSessionComposer {...baseProps} />)

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    expect(
      screen.getByRole('menuitem', { name: /New worktree from main/i })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Worktree options/i }))
    expect(
      screen.getByRole('button', { name: /Base branch: main/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Worktree name: Automatic/i })
    ).toBeInTheDocument()
  })

  it('blocks invalid worktree names before dispatching creation', () => {
    render(<NewSessionComposer {...baseProps} />)
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Create safely' },
    })
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Worktree options/i }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Worktree name: Automatic' })
    )
    fireEvent.change(screen.getByPlaceholderText('Automatic'), {
      target: { value: 'invalid name' },
    })

    expect(screen.getByText('Invalid worktree name')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    ).toBeDisabled()
  })

  it('keeps favorite base branch controls available', () => {
    render(<NewSessionComposer {...baseProps} />)
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Worktree options/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Base branch: main' }))
    fireEvent.click(screen.getByRole('button', { name: 'Star develop' }))

    expect(preferenceMocks.patch).toHaveBeenCalledWith({
      favorite_base_branches: ['project-1:develop'],
    })
  })

  it('refreshes the displayed base branch when project settings change', () => {
    const { rerender } = render(<NewSessionComposer {...baseProps} />)

    expect(
      screen.getByRole('button', { name: 'Choose starting point' })
    ).toHaveTextContent('New worktree from main')

    rerender(<NewSessionComposer {...baseProps} defaultBranch="develop" />)

    expect(
      screen.getByRole('button', { name: 'Choose starting point' })
    ).toHaveTextContent('New worktree from develop')
  })

  it('keeps every valid remote start point available', () => {
    render(
      <NewSessionComposer
        {...baseProps}
        remotes={[
          { name: 'origin', repo: 'coollabsio/jean' },
          { name: 'fork', repo: 'fares/jean' },
        ]}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Choose starting point' })
    ).toHaveTextContent('New worktree from origin/main')
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    expect(
      screen.getByRole('menuitem', { name: /origin\/main.*coollabsio\/jean/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /fork\/main.*fares\/jean/i })
    ).toBeInTheDocument()
  })

  it('creates from the remote selected in Create from', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      id: 'remote-worktree',
      path: '/repo/remote-worktree',
      name: 'remote-worktree',
    })
    flowMocks.finish.mockImplementation(() => new Promise(() => undefined))
    render(
      <NewSessionComposer
        {...baseProps}
        createWorktree={createWorktree}
        remotes={[{ name: 'origin' }, { name: 'fork' }]}
      />
    )

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /fork\/main/i }))
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Create from my fork' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )

    await waitFor(() =>
      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ baseBranch: 'fork/main' })
      )
    )
  })

  it('drops unavailable remotes when the base branch changes', () => {
    render(
      <NewSessionComposer
        {...baseProps}
        remotes={[{ name: 'origin' }, { name: 'fork' }]}
      />
    )
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Worktree options/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Base branch: main' }))
    projectServiceState.remotes = [{ name: 'origin' }]
    fireEvent.click(screen.getByText('develop'))

    expect(
      screen.getByRole('button', { name: 'Choose starting point' })
    ).toHaveTextContent('New worktree from develop')
  })

  it('does not create a session when no authenticated backend is available', () => {
    backendState.installedBackends = []
    render(<NewSessionComposer {...baseProps} />)

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'This cannot run yet' },
    })
    expect(
      screen.getByRole('button', { name: /no backend available/i })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Configure agents' }))
    expect(baseProps.onConfigureBackends).toHaveBeenCalledOnce()
  })

  it('keeps the base branch selector for an issue', () => {
    render(
      <NewSessionComposer
        {...baseProps}
        source={{
          type: 'issue',
          item: { number: 12, title: 'Issue' } as never,
        }}
        sourceContext={{
          type: 'issue',
          kind: 'GitHub issue #12',
          label: 'Issue',
        }}
      />
    )

    const sourceTrigger = screen.getByRole('button', {
      name: 'Choose starting point',
    })
    expect(sourceTrigger).toHaveTextContent('GitHub issue #12')
    expect(sourceTrigger).toHaveAttribute(
      'title',
      'The agent receives the issue title, description, labels and discussion.'
    )
    expect(screen.queryByText(/The agent receives/)).not.toBeInTheDocument()
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Worktree options/i }))
    expect(screen.getByRole('button', { name: /main/i })).toBeInTheDocument()
  })

  it.each([
    [
      'pr',
      { number: 42, title: 'PR', headRefName: 'feature', baseRefName: 'main' },
    ],
    [
      'stack-pr',
      { number: 42, title: 'PR', headRefName: 'feature', baseRefName: 'main' },
    ],
  ] as const)(
    'hides the base selector when %s owns the branch',
    (type, item) => {
      render(
        <NewSessionComposer
          {...baseProps}
          source={{ type, item } as never}
          sourceContext={{ type, kind: 'Pull request #42', label: 'PR' }}
        />
      )

      fireEvent.pointerDown(
        screen.getByRole('button', { name: 'Choose starting point' })
      )
      fireEvent.click(
        screen.getByRole('menuitem', { name: /Worktree options/i })
      )
      expect(
        screen.queryByRole('button', { name: /main/i })
      ).not.toBeInTheDocument()
    }
  )

  it('does not surface setup details in the prompt-first view', () => {
    render(<NewSessionComposer {...baseProps} setupScript="bun install" />)
    expect(screen.queryByText('Setup before prompt')).not.toBeInTheDocument()
  })

  it('keeps project setup configuration available when it is missing', () => {
    const onConfigureProject = vi.fn()
    render(
      <NewSessionComposer
        {...baseProps}
        showConfigureProject
        onConfigureProject={onConfigureProject}
      />
    )

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Configure project setup' })
    )
    expect(onConfigureProject).toHaveBeenCalledOnce()
  })

  it('makes an existing base session explicit', () => {
    render(<NewSessionComposer {...baseProps} hasBaseSession />)
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    expect(
      screen.getByRole('menuitem', {
        name: /Project folder.*Open the existing project session/i,
      })
    ).toBeInTheDocument()
  })

  it('restores composer settings after returning from the context browser', () => {
    render(
      <NewSessionComposer
        {...baseProps}
        initialSettings={{
          backend: 'codex',
          model: 'gpt-5.6-codex',
          executionMode: 'yolo',
          baseBranch: 'develop',
          customName: 'kept-name',
        }}
      />
    )

    expect(screen.getByText('codex:gpt-5.6-codex')).toBeInTheDocument()
    expect(screen.getByText('yolo mode')).toBeInTheDocument()
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Worktree options/i }))
    expect(screen.getByRole('button', { name: /develop/i })).toBeInTheDocument()
    expect(screen.getByText('kept-name')).toBeInTheDocument()
  })

  it('closes as soon as creation is dispatched and completes the setup in background', async () => {
    const pendingWorktree = {
      id: 'worktree-1',
      path: '/repo/worktree-1',
      name: 'worktree-1',
    } as never
    let finishFlow: ((value: unknown) => void) | undefined
    flowMocks.finish.mockImplementation(
      () =>
        new Promise(resolve => {
          finishFlow = resolve
        })
    )
    const createWorktree = vi.fn().mockResolvedValue(pendingWorktree)
    const onCreated = vi.fn()
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    render(
      <NewSessionComposer
        {...baseProps}
        createWorktree={createWorktree}
        onCreated={onCreated}
      />
    )

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Build the complete flow' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )

    await waitFor(() => expect(createWorktree).toHaveBeenCalledOnce())
    expect(onCreated).toHaveBeenCalledOnce()
    expect(flowMocks.finish).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Prompt')).toHaveValue('')

    finishFlow?.({
      worktree: pendingWorktree,
      session: { id: 'session-1' },
    })
    await waitFor(() =>
      expect(dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'open-worktree-modal' })
      )
    )
  })

  it('keeps the composer reusable while a long setup is still running', async () => {
    const pendingWorktree = {
      id: 'worktree-2',
      path: '/repo/worktree-2',
      name: 'worktree-2',
    } as never
    flowMocks.finish.mockImplementation(() => new Promise(() => undefined))
    const createWorktree = vi.fn().mockResolvedValue(pendingWorktree)
    const onCreated = vi.fn()
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    render(
      <NewSessionComposer
        {...baseProps}
        createWorktree={createWorktree}
        onCreated={onCreated}
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Create more' }))
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Create the first worktree' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )

    await waitFor(() => expect(flowMocks.finish).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
    expect(onCreated).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open-worktree-modal' })
    )
    expect(
      screen.getByRole('button', { name: /^Create worktree\s*↵$/ })
    ).toBeEnabled()
  })

  it('sends the prompt once a long setup finishes', async () => {
    const pendingWorktree = {
      id: 'worktree-long-setup',
      path: '/repo/worktree-long-setup',
      name: 'worktree-long-setup',
    } as never
    let finishFlow: ((value: unknown) => void) | undefined
    flowMocks.finish.mockImplementation(
      () =>
        new Promise(resolve => {
          finishFlow = resolve
        })
    )
    render(
      <NewSessionComposer
        {...baseProps}
        setupScript="bun install"
        createWorktree={vi.fn().mockResolvedValue(pendingWorktree)}
      />
    )

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Send after setup' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )
    await waitFor(() => expect(flowMocks.finish).toHaveBeenCalledOnce())
    expect(
      useChatStore.getState().pendingSetupPrompts['worktree-long-setup']
    ).toBe('Send after setup')

    finishFlow?.({
      worktree: pendingWorktree,
      session: { id: 'session-after-setup' },
    })

    await waitFor(() => expect(flowMocks.startPrompt).toHaveBeenCalledOnce())
    expect(flowMocks.startPrompt).toHaveBeenCalledWith(
      expect.any(Function),
      pendingWorktree,
      expect.objectContaining({ id: 'session-after-setup' }),
      expect.objectContaining({ message: 'Send after setup' })
    )
    await waitFor(() =>
      expect(
        useChatStore.getState().pendingSetupPrompts['worktree-long-setup']
      ).toBeUndefined()
    )
  })

  it('creates a worktree without queuing a message when the prompt is empty', async () => {
    const pendingWorktree = {
      id: 'worktree-without-prompt',
      path: '/repo/worktree-without-prompt',
      name: 'worktree-without-prompt',
    } as never
    flowMocks.finish.mockResolvedValue({
      worktree: pendingWorktree,
      session: { id: 'session-without-prompt' },
    })
    const createWorktree = vi.fn().mockResolvedValue(pendingWorktree)
    render(
      <NewSessionComposer {...baseProps} createWorktree={createWorktree} />
    )

    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree\s*↵$/ })
    )

    await waitFor(() => expect(createWorktree).toHaveBeenCalledOnce())
    await waitFor(() => expect(flowMocks.finish).toHaveBeenCalledOnce())
    expect(flowMocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({ queuedMessage: undefined })
    )
    expect(
      useChatStore.getState().getQueuedMessages('session-without-prompt')
    ).toEqual([])
  })

  it('starts a conversation when an attachment is added without text', async () => {
    const pendingWorktree = {
      id: 'worktree-with-attachment',
      path: '/repo/worktree-with-attachment',
      name: 'worktree-with-attachment',
    } as never
    flowMocks.finish.mockResolvedValue({
      worktree: pendingWorktree,
      session: { id: 'session-with-attachment' },
    })
    render(
      <NewSessionComposer
        {...baseProps}
        createWorktree={vi.fn().mockResolvedValue(pendingWorktree)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(screen.getByAltText('screenshot.png')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )

    await waitFor(() => expect(flowMocks.startPrompt).toHaveBeenCalledOnce())
    expect(flowMocks.startPrompt).toHaveBeenCalledWith(
      expect.any(Function),
      pendingWorktree,
      expect.objectContaining({ id: 'session-with-attachment' }),
      expect.objectContaining({
        message: '',
        pendingImages: [
          expect.objectContaining({
            id: 'attached-image',
            filename: 'screenshot.png',
          }),
        ],
      })
    )
  })

  it('keeps the prompt retryable when Create more fails', async () => {
    const createWorktree = vi.fn().mockRejectedValue(new Error('boom'))
    const onCreated = vi.fn()
    render(
      <NewSessionComposer
        {...baseProps}
        createWorktree={createWorktree}
        onCreated={onCreated}
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Create more' }))
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Keep this after failure' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )

    await waitFor(() => expect(createWorktree).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
      ).toBeEnabled()
    )
    expect(screen.getByLabelText('Prompt')).toHaveValue(
      'Keep this after failure'
    )
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('unlocks a reopened composer after background creation fails', async () => {
    const pendingWorktree = {
      id: 'failed-worktree',
      path: '/repo/failed-worktree',
      name: 'failed-worktree',
    } as never
    const createWorktree = vi.fn().mockResolvedValue(pendingWorktree)
    flowMocks.finish.mockRejectedValue(new Error('Branch already exists'))
    const onCreated = vi.fn()
    const onRetry = vi.fn()
    render(
      <NewSessionComposer
        {...baseProps}
        createWorktree={createWorktree}
        onCreated={onCreated}
        onRetry={onRetry}
      />
    )

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Retry this prompt' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    )

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    await waitFor(() => expect(flowMocks.finish).toHaveBeenCalledOnce())
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue('Retry this prompt')
    )
    expect(
      screen.getByRole('button', { name: /^Create worktree & start\s*↵$/ })
    ).toBeEnabled()
  })

  it('routes the project-folder option through the same prompt-first flow', async () => {
    const createBaseSession = vi.fn().mockResolvedValue({
      id: 'base-1',
      path: '/repo',
      name: 'main',
    })
    flowMocks.finish.mockResolvedValue({
      worktree: { id: 'base-1', path: '/repo', name: 'main' },
      session: { id: 'session-1' },
    })
    const onCreated = vi.fn()
    render(
      <NewSessionComposer
        {...baseProps}
        source={{ type: 'base' }}
        sourceContext={{
          type: 'base',
          kind: 'Project folder',
          label: 'Work directly on the base checkout',
        }}
        createBaseSession={createBaseSession}
        onCreated={onCreated}
      />
    )

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Inspect the project directly' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Start in project folder\s*↵$/ })
    )

    await waitFor(() => expect(createBaseSession).toHaveBeenCalledOnce())
    expect(flowMocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({ createFreshSession: true })
    )
    expect(baseProps.createWorktree).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: /main/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /worktree name/i })
    ).not.toBeInTheDocument()
  })

  it('checks out an existing branch through the dedicated creation command', async () => {
    const branchWorktree = {
      id: 'branch-1',
      path: '/repo/feature-existing',
      name: 'feature-existing',
    }
    const createWorktree = vi.fn()
    const createWorktreeFromBranch = vi.fn().mockResolvedValue(branchWorktree)
    flowMocks.finish.mockResolvedValue({
      worktree: branchWorktree,
      session: { id: 'session-1' },
    })
    render(
      <NewSessionComposer
        {...baseProps}
        source={{ type: 'branch', branch: 'feature/existing' }}
        sourceContext={{
          type: 'branch',
          kind: 'Existing branch',
          label: 'feature/existing',
        }}
        createWorktree={createWorktree}
        createWorktreeFromBranch={createWorktreeFromBranch}
      />
    )

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Continue on this branch' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Open branch in worktree\s*↵$/ })
    )

    await waitFor(() =>
      expect(createWorktreeFromBranch).toHaveBeenCalledWith('feature/existing')
    )
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('does not offer an empty worktree-options panel for existing branches', () => {
    render(
      <NewSessionComposer
        {...baseProps}
        source={{ type: 'branch', branch: 'feature/existing' }}
        sourceContext={{
          type: 'branch',
          kind: 'Existing branch',
          label: 'feature/existing',
        }}
      />
    )

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Choose starting point' })
    )

    expect(
      screen.queryByRole('menuitem', { name: /Worktree options/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('worktree-options')).not.toBeInTheDocument()
  })
})

describe('getNewWorktreeDraftId', () => {
  it('isolates unfinished prompts and attachments by project', () => {
    expect(getNewWorktreeDraftId('project-a')).not.toBe(
      getNewWorktreeDraftId('project-b')
    )
  })
})
