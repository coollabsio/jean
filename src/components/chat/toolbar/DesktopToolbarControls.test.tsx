import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { ComponentProps } from 'react'
import { DesktopToolbarControls } from './DesktopToolbarControls'

class ResizeObserverMock {
  observe() {
    return undefined
  }
  unobserve() {
    return undefined
  }
  disconnect() {
    return undefined
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/platform', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/platform')>('@/lib/platform') // eslint-disable-line @typescript-eslint/consistent-type-imports

  return {
    ...actual,
    openExternal: vi.fn(),
  }
})

type DesktopToolbarControlsProps = ComponentProps<typeof DesktopToolbarControls>

function renderDesktopToolbarControls(
  props: Partial<DesktopToolbarControlsProps> = {}
) {
  const defaultProps: DesktopToolbarControlsProps = {
    hasPendingQuestions: false,
    selectedBackend: 'codex',
    selectedModel: 'gpt-5.4',
    selectedProvider: null,
    selectedThinkingLevel: 'think',
    selectedEffortLevel: 'medium',
    executionMode: 'plan',
    useAdaptiveThinking: false,
    hideThinkingLevel: false,
    sessionHasMessages: false,
    providerLocked: false,
    customCliProfiles: [],
    isCodex: true,
    prUrl: undefined,
    prNumber: undefined,
    displayStatus: undefined,
    checkStatus: undefined,
    mergeableStatus: undefined,
    activeWorktreePath: undefined,
    availableMcpServers: [],
    enabledMcpServers: [],
    isHealthChecking: false,
    mcpStatuses: undefined,
    loadedIssueContexts: [],
    loadedPRContexts: [],
    loadedSecurityContexts: [],
    loadedAdvisoryContexts: [],
    loadedLinearContexts: [],
    attachedSavedContexts: [],
    providerDropdownOpen: false,
    thinkingDropdownOpen: false,
    mcpDropdownOpen: false,
    setProviderDropdownOpen: vi.fn(),
    setThinkingDropdownOpen: vi.fn(),
    onMcpDropdownOpenChange: vi.fn(),
    onOpenMagicModal: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onResolvePrConflicts: vi.fn(),
    onLoadContext: vi.fn(),
    onAttach: vi.fn(),
    installedBackends: ['claude', 'codex', 'opencode'],
    onSetExecutionMode: vi.fn(),
    availableExecutionModes: ['plan', 'build', 'yolo'],
    onToggleMcpServer: vi.fn(),
    handleModelChange: vi.fn(),
    handleBackendModelChange: vi.fn(),
    handleProviderChange: vi.fn(),
    handleThinkingLevelChange: vi.fn(),
    handleEffortLevelChange: vi.fn(),
    handleViewIssue: vi.fn(),
    handleViewPR: vi.fn(),
    handleViewSecurityAlert: vi.fn(),
    handleViewAdvisory: vi.fn(),
    handleViewLinear: vi.fn(),
    handleViewSavedContext: vi.fn(),
  }

  return render(<DesktopToolbarControls {...defaultProps} {...props} />)
}

describe('DesktopToolbarControls', () => {
  it.each([
    ['plan', 'Plan'],
    ['build', 'Build'],
    ['yolo', 'Yolo'],
  ] as const)('shows %s label in the desktop mode trigger', (mode, label) => {
    renderDesktopToolbarControls({ executionMode: mode })

    expect(
      screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
    ).toBeInTheDocument()
  })

  it('keeps mode options selectable from the dropdown', async () => {
    const user = userEvent.setup()
    const onSetExecutionMode = vi.fn()

    renderDesktopToolbarControls({
      executionMode: 'plan',
      onSetExecutionMode,
    })

    await user.click(screen.getByRole('button', { name: /^plan$/i }))
    await user.click(
      await screen.findByRole('menuitemradio', { name: /build/i })
    )

    expect(onSetExecutionMode).toHaveBeenCalledWith('build')
  })

  it('shows a desktop Magic button that opens the magic modal', async () => {
    const user = userEvent.setup()
    const onOpenMagicModal = vi.fn()

    renderDesktopToolbarControls({ onOpenMagicModal })

    await user.click(screen.getByRole('button', { name: /magic/i }))

    expect(onOpenMagicModal).toHaveBeenCalledTimes(1)
  })

  it('shows a desktop Attachments button after Magic that opens file picker', async () => {
    const user = userEvent.setup()
    const onAttach = vi.fn()

    renderDesktopToolbarControls({ onAttach })

    const magicButton = screen.getByRole('button', { name: /magic/i })
    const attachmentsButton = screen.getByRole('button', {
      name: /attachments/i,
    })

    expect(
      magicButton.compareDocumentPosition(attachmentsButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await user.click(attachmentsButton)

    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('keeps desktop Magic and settings controls usable while questions are pending', () => {
    renderDesktopToolbarControls({ hasPendingQuestions: true })

    expect(screen.getByRole('button', { name: /magic/i })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /choose backend and model/i })
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: /medium/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^plan$/i })).toBeEnabled()
  })

  it('keeps Claude provider switcher available after messages exist', () => {
    renderDesktopToolbarControls({
      selectedBackend: 'claude',
      selectedModel: 'sonnet',
      selectedProvider: null,
      customCliProfiles: [{ name: 'OpenRouter', settings_json: '{}' }],
      providerLocked: true,
      sessionHasMessages: true,
      isCodex: false,
    })

    expect(
      screen.getByRole('button', { name: /anthropic/i })
    ).toBeInTheDocument()
  })

  it('hides reasoning control for Command Code on desktop', () => {
    renderDesktopToolbarControls({
      selectedBackend: 'commandcode',
      selectedModel: 'commandcode/default',
      isCodex: false,
      useAdaptiveThinking: false,
      hideThinkingLevel: false,
    })

    expect(
      screen.queryByRole('button', { name: /think/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
  })

  it('hides Claude-only Max and Ultracode effort for Codex', () => {
    renderDesktopToolbarControls({
      isCodex: true,
      selectedBackend: 'codex',
      useAdaptiveThinking: false,
      selectedEffortLevel: 'max',
      thinkingDropdownOpen: true,
    })

    expect(screen.getByText('xHigh')).toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
    expect(screen.queryByText('Ultracode')).not.toBeInTheDocument()
  })

  it('renders effort levels supplied by the selected model catalog entry', () => {
    renderDesktopToolbarControls({
      selectedBackend: 'codex',
      selectedModel: 'gpt-5.6-sol',
      selectedEffortLevel: 'ultra',
      thinkingDropdownOpen: true,
      modelReasoning: {
        type: 'effort',
        default: 'medium',
        levels: [
          { value: 'medium', label: 'Medium', description: 'Balanced' },
          {
            value: 'ultra',
            label: 'Ultra',
            description: 'Automatic delegation',
          },
        ],
      },
    })

    expect(screen.getAllByText('Ultra').length).toBeGreaterThan(0)
    expect(screen.getByText('Automatic delegation')).toBeInTheDocument()
    expect(screen.queryByText('xHigh')).not.toBeInTheDocument()
  })

  it('renders thinking levels supplied by the selected model catalog entry', () => {
    renderDesktopToolbarControls({
      selectedBackend: 'claude',
      selectedModel: 'claude-legacy',
      isCodex: false,
      selectedThinkingLevel: 'megathink',
      thinkingDropdownOpen: true,
      modelReasoning: {
        type: 'thinking',
        default: 'think',
        levels: [
          { value: 'think', label: 'Think', description: '4K' },
          { value: 'megathink', label: 'Mega', description: '10K' },
        ],
      },
    })

    expect(screen.getAllByText('Mega').length).toBeGreaterThan(0)
    expect(screen.getByText('10K')).toBeInTheDocument()
    expect(screen.queryByText('Ultrathink')).not.toBeInTheDocument()
  })

  it('shows PI effort options instead of Claude thinking on desktop', () => {
    renderDesktopToolbarControls({
      isCodex: false,
      selectedBackend: 'pi',
      selectedModel: 'pi/openai-codex/gpt-5.5',
      selectedEffortLevel: 'xhigh',
      useAdaptiveThinking: false,
      selectedThinkingLevel: 'megathink',
      thinkingDropdownOpen: true,
    })

    expect(
      screen.getByRole('menuitemradio', { name: /xhigh/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemradio', { name: /minimal/i })
    ).toBeInTheDocument()
    expect(screen.queryByText('Megathink')).not.toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
    expect(screen.queryByText('Ultracode')).not.toBeInTheDocument()
  })

  it('calls effort change handler when selecting an effort on desktop', async () => {
    const user = userEvent.setup()
    const handleEffortLevelChange = vi.fn()

    renderDesktopToolbarControls({
      isCodex: false,
      selectedBackend: 'claude',
      useAdaptiveThinking: true,
      selectedEffortLevel: 'medium',
      thinkingDropdownOpen: true,
      handleEffortLevelChange,
    })

    const xHighItem = screen
      .getAllByRole('menuitemradio', { name: /xhigh/i })
      .find(item => item.textContent?.startsWith('xHigh'))
    expect(xHighItem).toBeDefined()
    if (!xHighItem) return
    await user.click(xHighItem)

    expect(handleEffortLevelChange).toHaveBeenCalledWith('xhigh')
  })

  it('keeps Max effort available for Claude adaptive thinking', () => {
    renderDesktopToolbarControls({
      isCodex: false,
      selectedBackend: 'claude',
      useAdaptiveThinking: true,
      selectedEffortLevel: 'max',
      thinkingDropdownOpen: true,
    })

    expect(screen.getAllByText('Max').length).toBeGreaterThan(0)
  })

  it('keeps Ultracode effort available for Claude adaptive thinking', () => {
    renderDesktopToolbarControls({
      isCodex: false,
      selectedBackend: 'claude',
      useAdaptiveThinking: true,
      selectedEffortLevel: 'ultracode',
      thinkingDropdownOpen: true,
    })

    expect(screen.getAllByText('Ultracode').length).toBeGreaterThan(0)
  })
})
