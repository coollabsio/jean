import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { within } from '@testing-library/react'
import { render, screen } from '@/test/test-utils'
import { BackendModelPickerContent } from './BackendModelPickerContent'

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

const refreshOpencodeModelsMutateAsync = vi.fn()

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({
    data: ['openai/gpt-5.4', 'groq/compound-mini'],
  }),
  useRefreshOpencodeModels: () => ({
    mutateAsync: refreshOpencodeModelsMutateAsync,
    isPending: false,
  }),
}))

vi.mock('@/services/commandcode-cli', () => ({
  useAvailableCommandCodeModels: () => ({
    data: [{ id: 'auto', label: 'Auto' }],
  }),
}))

const patchPreferencesMutate = vi.fn()
let mockFavoriteModels: string[] = []
let mockFastModeModels: string[] = []
let mockCursorModels: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto' },
]

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({
    data: mockCursorModels,
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      favorite_models: mockFavoriteModels,
      fast_mode_models: mockFastModeModels,
    },
  }),
  usePatchPreferences: () => ({ mutate: patchPreferencesMutate }),
}))

beforeEach(() => {
  mockFavoriteModels = []
  mockFastModeModels = []
  mockCursorModels = [{ id: 'auto', label: 'Auto' }]
  patchPreferencesMutate.mockClear()
  refreshOpencodeModelsMutateAsync.mockReset()
  refreshOpencodeModelsMutateAsync.mockResolvedValue(['openai/gpt-5.4'])
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

describe('BackendModelPickerContent', () => {
  it('shows a manual refresh button for CDN-backed Claude and Codex model lists', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.5"
        selectedProvider={null}
        installedBackends={['claude', 'codex']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: /refresh model list/i })
    ).toBeInTheDocument()
  })

  it('shows a manual refresh button for OpenCode CLI model lists', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="opencode"
        selectedModel="openai/gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const refreshButton = screen.getByRole('button', {
      name: /refresh model list/i,
    })
    expect(refreshButton).toBeInTheDocument()

    await user.click(refreshButton)
    expect(refreshOpencodeModelsMutateAsync).toHaveBeenCalledTimes(1)
  })

  it('does not show a refresh button for Cursor model lists', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="cursor"
        selectedModel="cursor/auto"
        selectedProvider={null}
        installedBackends={['cursor']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(
      screen.queryByRole('button', { name: /refresh model list/i })
    ).not.toBeInTheDocument()
  })
  it('keeps Claude 1M variants plus standard models', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-opus-4-8[1m]"
        selectedProvider={null}
        installedBackends={['claude']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(screen.getByText('Fable 5')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.8 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.7 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.6 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Sonnet 4.6 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Sonnet 4.6')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.5')).toBeInTheDocument()
    expect(screen.getByText('Haiku')).toBeInTheDocument()
  })

  it('renders backend sidebar and switches backend+model on selection', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()
    const onRequestClose = vi.fn()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="opencode"
        selectedModel="openai/gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
        onRequestClose={onRequestClose}
      />
    )

    expect(screen.getByRole('tab', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Codex' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'OpenCode' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Codex' }))
    await user.click(screen.getByText('GPT 5.4'))

    expect(onBackendModelChange).toHaveBeenCalledWith('codex', 'gpt-5.4')
    expect(onModelChange).not.toHaveBeenCalled()
    expect(onRequestClose).toHaveBeenCalled()
  })

  it('shows the beta sidebar dot on Command Code and Grok, not Cursor', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="cursor"
        selectedModel="cursor/auto"
        selectedProvider={null}
        installedBackends={['cursor', 'commandcode', 'grok']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const cursorTab = screen.getByRole('tab', { name: 'Cursor' })
    const commandCodeTab = screen.getByRole('tab', {
      name: 'Command Code (Beta)',
    })
    const grokTab = screen.getByRole('tab', { name: 'Grok (Beta)' })

    expect(cursorTab.querySelector('.bg-yellow-500')).toBeNull()
    expect(commandCodeTab.querySelector('.bg-yellow-500')).not.toBeNull()
    expect(grokTab.querySelector('.bg-yellow-500')).not.toBeNull()
  })

  it('keeps the Cursor fallback model when web access caches an empty model list', () => {
    mockCursorModels = []

    render(
      <BackendModelPickerContent
        open
        selectedBackend="cursor"
        selectedModel="cursor/auto"
        selectedProvider={null}
        installedBackends={['cursor']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(screen.getByText('Auto')).toBeInTheDocument()
    expect(screen.queryByText('No Cursor models found.')).toBeNull()
  })

  it('does not add an empty custom Command Code model option', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="commandcode"
        selectedModel="commandcode/default"
        selectedProvider={null}
        installedBackends={['commandcode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const searchInput = screen.getByPlaceholderText(/search command code/i)
    await user.type(searchInput, 'commandcode/')

    expect(
      screen.queryByText('Use Command Code model "commandcode/"')
    ).toBeNull()
  })

  it('scopes search to active backend and supports same-backend model swap', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.3"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
        onRequestClose={vi.fn()}
      />
    )

    const searchInput = screen.getByPlaceholderText(/search codex models/i)
    await user.type(searchInput, 'gpt 5.4')
    await user.click(screen.getByText('GPT 5.4'))

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.4')
    expect(onBackendModelChange).not.toHaveBeenCalled()
  })

  it('renders inline fast toggles only on codex models that support fast tier', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.5"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(
      screen.getByRole('switch', { name: /enable fast mode for gpt 5\.5/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: /enable fast mode for gpt 5\.4$/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: /enable fast mode for gpt 5\.4 mini/i,
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: /enable fast mode for gpt 5\.3/i })
    ).toBeNull()
    expect(screen.getAllByText(/(?:⌘|Ctrl )F/).length).toBeGreaterThan(0)
  })

  it('keeps fast, favourite, and selected indicators in stable action slots', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.5"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const fastRowActions = screen.getByTestId('model-actions-codex-gpt-5.5')
    const fastToggle = screen.getByRole('switch', {
      name: /enable fast mode for gpt 5\.5/i,
    })
    const favoriteToggle = screen.getByRole('switch', {
      name: /^favorite gpt 5\.5$/i,
    })
    expect(fastRowActions.children).toHaveLength(3)
    expect(fastRowActions.children[0]).toContainElement(fastToggle)
    expect(fastRowActions.children[1]).toBe(favoriteToggle)
    expect(
      fastToggle.compareDocumentPosition(favoriteToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    const nonFastRowActions = screen.getByTestId('model-actions-codex-gpt-5.3')
    const nonFastFavoriteToggle = screen.getByRole('switch', {
      name: /^favorite gpt 5\.3$/i,
    })
    expect(nonFastRowActions.children).toHaveLength(3)
    expect(nonFastRowActions.children[0]).toBeEmptyDOMElement()
    expect(nonFastRowActions.children[1]).toBe(nonFastFavoriteToggle)
  })

  it('toggles codex fast tier on a model row', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()

    const { rerender } = render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.5"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const fastToggle = screen.getByRole('switch', {
      name: /enable fast mode for gpt 5\.5/i,
    })
    expect(fastToggle).toHaveAttribute('aria-checked', 'false')

    await user.click(fastToggle)
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.5-fast')

    rerender(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.5-fast"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const fastToggleOn = screen.getByRole('switch', {
      name: /disable fast mode for gpt 5\.5/i,
    })
    expect(fastToggleOn).toHaveAttribute('aria-checked', 'true')

    await user.click(fastToggleOn)
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.5')
  })

  it('floats favourited models to the top of the list', () => {
    mockFavoriteModels = ['claude:claude-opus-4-6[1m]']

    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-opus-4-8[1m]"
        selectedProvider={null}
        installedBackends={['claude']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const labels = screen
      .getAllByRole('option')
      .map(opt => opt.textContent ?? '')
    const opus46Index = labels.findIndex(t => t.includes('claude-opus-4-6[1m]'))
    const opus48Index = labels.findIndex(t => t.includes('claude-opus-4-8[1m]'))
    expect(opus46Index).toBeGreaterThanOrEqual(0)
    expect(opus48Index).toBeGreaterThanOrEqual(0)
    expect(opus46Index).toBeLessThan(opus48Index)
  })

  it('does not show fast mode for Claude Fable 5', () => {
    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-fable-5"
        selectedProvider={null}
        installedBackends={['claude']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const fableActions = screen.getByTestId(
      'model-actions-claude-claude-fable-5'
    )
    expect(
      within(fableActions).queryByRole('switch', { name: /fast mode/i })
    ).not.toBeInTheDocument()
  })

  it('toggles favourite status for Claude Fable 5 via the star button', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-fable-5"
        selectedProvider={null}
        installedBackends={['claude']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const starBtn = screen.getByRole('switch', {
      name: /^favorite fable 5$/i,
    })
    expect(starBtn).toHaveAttribute('aria-checked', 'false')

    await user.click(starBtn)
    expect(patchPreferencesMutate).toHaveBeenCalledWith({
      favorite_models: ['claude:claude-fable-5'],
    })
  })

  it('toggles favourite status via the star button', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-opus-4-8[1m]"
        selectedProvider={null}
        installedBackends={['claude']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    const starBtn = screen.getByRole('switch', {
      name: /^favorite opus 4\.8 \(1m\)$/i,
    })
    expect(starBtn).toHaveAttribute('aria-checked', 'false')

    await user.click(starBtn)
    expect(patchPreferencesMutate).toHaveBeenCalledWith({
      favorite_models: ['claude:claude-opus-4-8[1m]'],
    })
  })

  it('persists fast mode in fast_mode_models and replays it on row click', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()

    const { rerender } = render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
        onRequestClose={vi.fn()}
      />
    )

    // Toggle fast on GPT 5.5 row → expect fast_mode_models patch + model swap
    const fastBtn = screen.getByRole('switch', {
      name: /enable fast mode for gpt 5\.5/i,
    })
    await user.click(fastBtn)
    expect(patchPreferencesMutate).toHaveBeenCalledWith({
      fast_mode_models: ['codex:gpt-5.5'],
    })
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.5-fast')

    // Simulate prefs reflecting the saved fast memory + selection back on gpt-5.4
    mockFastModeModels = ['codex:gpt-5.5']
    onModelChange.mockClear()

    rerender(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
        onRequestClose={vi.fn()}
      />
    )

    // Click GPT 5.5 row label → should replay fast variant
    await user.click(screen.getByText('GPT 5.5'))
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.5-fast')
  })

  it('uses Cmd+F to select the highlighted row fast mode', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onRequestClose = vi.fn()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.3"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={vi.fn()}
        onRequestClose={onRequestClose}
      />
    )

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Meta>}f{/Meta}')

    expect(patchPreferencesMutate).toHaveBeenCalledWith({
      fast_mode_models: ['codex:gpt-5.6-sol'],
    })
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-sol-fast')
    expect(onRequestClose).toHaveBeenCalled()
  })

  it('Cmd+F is a no-op when the highlighted row has no fast mode', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onRequestClose = vi.fn()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['codex']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={vi.fn()}
        onRequestClose={onRequestClose}
      />
    )

    await user.type(
      screen.getByPlaceholderText(/search codex models/i),
      'gpt 5.3'
    )
    await user.keyboard('{Meta>}f{/Meta}')

    expect(patchPreferencesMutate).not.toHaveBeenCalledWith({
      fast_mode_models: expect.any(Array),
    })
    expect(onModelChange).not.toHaveBeenCalled()
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('switches active backend tab via Cmd+digit shortcut', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-opus-4-8[1m]"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await user.keyboard('{Meta>}2{/Meta}')

    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await user.keyboard('{Meta>}3{/Meta}')

    expect(screen.getByRole('tab', { name: 'OpenCode' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('Cmd+digit out of range is a no-op', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        selectedBackend="claude"
        selectedModel="claude-opus-4-8[1m]"
        selectedProvider={null}
        installedBackends={['claude', 'codex']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    await user.keyboard('{Meta>}9{/Meta}')

    expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('Cmd+digit switches backend even after the session has messages', async () => {
    const user = userEvent.setup()

    render(
      <BackendModelPickerContent
        open
        sessionHasMessages
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await user.keyboard('{Meta>}1{/Meta}')

    expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('keeps backend tabs enabled once the session has messages', () => {
    render(
      <BackendModelPickerContent
        open
        sessionHasMessages
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
        onRequestClose={vi.fn()}
      />
    )

    expect(screen.getByRole('tab', { name: 'Claude' })).not.toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Codex' })).not.toBeDisabled()
    expect(screen.getByRole('tab', { name: 'OpenCode' })).not.toBeDisabled()
  })
})
