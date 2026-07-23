import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { DesktopBackendModelPicker } from './DesktopBackendModelPicker'
import type * as EnvironmentModule from '@/lib/environment'

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

const modelMocks = vi.hoisted(() => ({
  opencodeModels: ['openai/gpt-5.4', 'groq/compound-mini'],
  opencodeModelsError: false,
  cursorModels: [{ id: 'auto', label: 'Auto' }],
  piModels: [{ id: 'openai-codex/gpt-5.5', label: 'gpt-5.5 (openai-codex)' }],
}))

const envMocks = vi.hoisted(() => ({
  isNativeApp: true,
  isMobile: false,
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => envMocks.isNativeApp,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => envMocks.isMobile,
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({
    data: modelMocks.opencodeModels,
    isError: modelMocks.opencodeModelsError,
  }),
  useRefreshOpencodeModels: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({
    data: modelMocks.cursorModels,
  }),
}))

vi.mock('@/services/pi-cli', () => ({
  useAvailablePiModels: () => ({
    data: modelMocks.piModels,
  }),
}))

beforeEach(() => {
  envMocks.isNativeApp = true
  envMocks.isMobile = false
  modelMocks.opencodeModels = ['openai/gpt-5.4', 'groq/compound-mini']
  modelMocks.opencodeModelsError = false
  modelMocks.cursorModels = [{ id: 'auto', label: 'Auto' }]
  modelMocks.piModels = [
    { id: 'openai-codex/gpt-5.5', label: 'gpt-5.5 (openai-codex)' },
  ]
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

describe('DesktopBackendModelPicker', () => {
  it('hides the chevron when there is only one selectable backend/model choice', () => {
    modelMocks.opencodeModels = ['openai/gpt-5.4']

    render(
      <DesktopBackendModelPicker
        selectedBackend="opencode"
        selectedModel="openai/gpt-5.4"
        selectedProvider={null}
        installedBackends={['opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(screen.queryByTestId('backend-model-picker-chevron')).toBeNull()
  })

  it('shows the chevron when another selectable choice is available', () => {
    modelMocks.opencodeModels = ['openai/gpt-5.4', 'groq/compound-mini']

    render(
      <DesktopBackendModelPicker
        selectedBackend="opencode"
        selectedModel="openai/gpt-5.4"
        selectedProvider={null}
        installedBackends={['opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(
      screen.getByTestId('backend-model-picker-chevron')
    ).toBeInTheDocument()
  })

  it('opens picker, lists backend tabs, and selects a model from another backend', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()

    render(
      <DesktopBackendModelPicker
        selectedBackend="opencode"
        selectedModel="openai/gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    const popoverContent = await screen.findByRole('tab', { name: 'Codex' })
    const list = popoverContent.closest('[data-slot="popover-content"]')
    expect(list).not.toBeNull()

    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'Claude' })
    ).toBeInTheDocument()
    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'Codex' })
    ).toBeInTheDocument()
    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'OpenCode' })
    ).toBeInTheDocument()

    await user.click(
      within(list as HTMLElement).getByRole('tab', { name: 'Codex' })
    )
    await user.click(within(list as HTMLElement).getByText('GPT 5.4'))

    expect(onBackendModelChange).toHaveBeenCalledWith('codex', 'gpt-5.4')
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('searches within the active backend and changes the model in-place', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()

    render(
      <DesktopBackendModelPicker
        selectedBackend="codex"
        selectedModel="gpt-5.3"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    const searchInput =
      await screen.findByPlaceholderText(/search codex models/i)
    await user.type(searchInput, 'gpt 5.4')
    await user.click(screen.getByText('GPT 5.4'))

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.4')
    expect(onBackendModelChange).not.toHaveBeenCalled()
  })

  it('keeps backend tabs enabled while a session has messages', async () => {
    const user = userEvent.setup()

    render(
      <DesktopBackendModelPicker
        sessionHasMessages
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    const codexTab = await screen.findByRole('tab', { name: 'Codex' })
    const list = codexTab.closest('[data-slot="popover-content"]')

    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'Claude' })
    ).not.toBeDisabled()
    expect(codexTab).not.toBeDisabled()
    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'OpenCode' })
    ).not.toBeDisabled()
  })

  it('shows the Tab shortcut hint on native desktop with multiple backends', () => {
    render(
      <DesktopBackendModelPicker
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(screen.getByText('Tab')).toBeInTheDocument()
  })

  it('hides the Tab shortcut hint in web access (non-native) contexts', () => {
    envMocks.isNativeApp = false

    render(
      <DesktopBackendModelPicker
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(screen.queryByText('Tab')).toBeNull()
  })

  it('hides the Tab shortcut hint on mobile', () => {
    envMocks.isMobile = true

    render(
      <DesktopBackendModelPicker
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(screen.queryByText('Tab')).toBeNull()
  })

  it('closes on Escape without bubbling to worktree Escape handlers', async () => {
    const user = userEvent.setup()
    const parentEscapeHandler = vi.fn()

    window.addEventListener('keydown', parentEscapeHandler)

    try {
      render(
        <DesktopBackendModelPicker
          selectedBackend="codex"
          selectedModel="gpt-5.4"
          selectedProvider={null}
          installedBackends={['claude', 'codex', 'opencode']}
          customCliProfiles={[]}
          onModelChange={vi.fn()}
          onBackendModelChange={vi.fn()}
        />
      )

      await user.click(
        screen.getByRole('button', { name: /choose backend and model/i })
      )
      expect(
        await screen.findByPlaceholderText(/search codex models/i)
      ).toBeInTheDocument()

      await user.keyboard('{Escape}')

      expect(screen.queryByPlaceholderText(/search codex models/i)).toBeNull()
      expect(parentEscapeHandler).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', parentEscapeHandler)
    }
  })

  it('uses active PI provider models in the picker and trigger label', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()

    render(
      <DesktopBackendModelPicker
        selectedBackend="pi"
        selectedModel="pi/openai-codex/gpt-5.5"
        selectedProvider={null}
        installedBackends={['pi']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(screen.getByText(/gpt-5\.5 \(openai-codex\)/i)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    expect(
      await screen.findByText('gpt-5.5 (openai-codex)')
    ).toBeInTheDocument()
    expect(screen.queryByText('Sonnet (PI)')).toBeNull()
  })

  it('shows the available PI default when stored PI model is unavailable', () => {
    render(
      <DesktopBackendModelPicker
        selectedBackend="pi"
        selectedModel="pi/sonnet"
        selectedProvider={null}
        installedBackends={['pi']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    expect(screen.getByText(/gpt-5\.5 \(openai-codex\)/i)).toBeInTheDocument()
    expect(screen.queryByText('· pi/sonnet')).toBeNull()
  })

  it('does not show the static OpenCode fallback when model fetching fails', async () => {
    const user = userEvent.setup()
    modelMocks.opencodeModels = undefined as unknown as string[]
    modelMocks.opencodeModelsError = true

    render(
      <DesktopBackendModelPicker
        selectedBackend="opencode"
        selectedModel="opencode/gpt-5.5"
        selectedProvider={null}
        installedBackends={['opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    expect(screen.queryByText('GPT-5.3 Codex (OpenCode)')).toBeNull()
    expect(
      await screen.findByText('No OpenCode models found.')
    ).toBeInTheDocument()
  })
})
