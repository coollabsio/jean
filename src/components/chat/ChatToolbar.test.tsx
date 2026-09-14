import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, render, screen } from '@/test/test-utils'
import { ChatToolbar } from './ChatToolbar'
import type { ChatToolbarProps } from './toolbar/types'
import { useUIStore } from '@/store/ui-store'

vi.mock('@/store/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      toggleModalTerminal: vi.fn(),
    }),
  },
}))

beforeEach(() => {
  useUIStore.setState({ zenMode: false })
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

function renderChatToolbar(props: Partial<ChatToolbarProps> = {}) {
  const defaultProps: ChatToolbarProps = {
    isSending: false,
    hasPendingQuestions: false,
    hasPendingAttachments: false,
    hasInputValue: false,
    executionMode: 'plan',
    selectedBackend: 'codex',
    selectedModel: 'gpt-5.4',
    selectedProvider: null,
    selectedThinkingLevel: 'think',
    selectedEffortLevel: 'medium',
    useAdaptiveThinking: false,
    hideThinkingLevel: false,
    sessionHasMessages: false,
    providerLocked: false,
    baseBranch: 'main',
    uncommittedAdded: 0,
    uncommittedRemoved: 0,
    branchDiffAdded: 0,
    branchDiffRemoved: 0,
    prUrl: undefined,
    prNumber: undefined,
    displayStatus: undefined,
    checkStatus: undefined,
    mergeableStatus: undefined,
    activeWorktreePath: undefined,
    worktreeId: null,
    activeSessionId: null,
    projectId: undefined,
    loadedIssueContexts: [],
    loadedPRContexts: [],
    loadedSecurityContexts: [],
    loadedAdvisoryContexts: [],
    loadedLinearContexts: [],
    loadedSentryContexts: [],
    attachedSavedContexts: [],
    onOpenMagicModal: vi.fn(),
    onSaveContext: vi.fn(),
    onLoadContext: vi.fn(),
    onCommit: vi.fn(),
    onCommitAndPush: vi.fn(),
    onOpenPr: vi.fn(),
    onReview: vi.fn(),
    onMerge: vi.fn(),
    onMergePr: vi.fn(),
    onResolvePrConflicts: vi.fn(),
    onResolveConflicts: vi.fn(),
    hasOpenPr: false,
    onSetDiffRequest: vi.fn(),
    installedBackends: ['claude', 'codex', 'opencode'],
    onModelChange: vi.fn(),
    onBackendModelChange: vi.fn(),
    onProviderChange: vi.fn(),
    customCliProfiles: [],
    onThinkingLevelChange: vi.fn(),
    onEffortLevelChange: vi.fn(),
    onSetExecutionMode: vi.fn(),
    onAttach: vi.fn(),
    onCancel: vi.fn(),
    queuedMessageCount: 0,
    availableMcpServers: [],
    enabledMcpServers: [],
    onToggleMcpServer: vi.fn(),
    onOpenProjectSettings: vi.fn(),
  }

  return render(<ChatToolbar {...defaultProps} {...props} />)
}

describe('ChatToolbar pending questions', () => {
  it('keeps bottom Magic menu and settings available while waiting for question input', async () => {
    const user = userEvent.setup()
    const onOpenMagicModal = vi.fn()

    renderChatToolbar({
      hasPendingQuestions: true,
      onOpenMagicModal,
    })

    expect(screen.getByRole('button', { name: /more actions/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /settings/i })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: /more actions/i }))

    expect(screen.queryByText('Magic')).not.toBeInTheDocument()
    expect(screen.getByText('Save Context')).toBeInTheDocument()
    expect(onOpenMagicModal).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Model')).toBeInTheDocument()
  })
})

describe('ChatToolbar zen mode', () => {
  it('hides chrome icons and keeps only send', () => {
    useUIStore.setState({ zenMode: true })
    renderChatToolbar({ hasInputValue: true })

    expect(
      screen
        .getByRole('button', { name: /more actions/i, hidden: true })
        .closest('.hidden')
    ).not.toBeNull()
    expect(
      screen
        .getByRole('button', { name: /settings/i, hidden: true })
        .closest('.hidden')
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
  })

  it('keeps model and reasoning shortcut popups mounted', async () => {
    useUIStore.setState({ zenMode: true })
    renderChatToolbar({ hasInputValue: true })

    expect(
      screen
        .getByRole('button', {
          name: /choose backend and model/i,
          hidden: true,
        })
        .closest('.hidden')
    ).not.toBeNull()

    act(() => {
      window.dispatchEvent(new CustomEvent('open-thinking-dropdown'))
    })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })
})
