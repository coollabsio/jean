import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
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

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({
    data: ['openai/gpt-5.4', 'groq/compound-mini'],
  }),
}))

const patchPreferencesMutate = vi.fn()
let mockFavoriteModels: string[] = []
let mockFastModeModels: string[] = []

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
  patchPreferencesMutate.mockClear()
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
  it('keeps Claude 1M variants plus models without 1M support', () => {
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

    expect(screen.getByText('Opus 4.8 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.7 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.6 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Sonnet 4.6 (1M)')).toBeInTheDocument()
    expect(screen.getByText('Opus 4.5')).toBeInTheDocument()
    expect(screen.getByText('Haiku')).toBeInTheDocument()
    expect(screen.queryByText('Sonnet 4.6')).toBeNull()
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
      fast_mode_models: ['codex:gpt-5.4'],
    })
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.4-fast')
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

  it('Cmd+digit can switch backend tabs after the session has messages', async () => {
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
