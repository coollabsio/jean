import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MobileBackendModelPickerSheet } from './MobileBackendModelPickerSheet'

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: [] }),
  useRefreshOpencodeModels: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))
vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({ data: [] }),
}))
vi.mock('@/services/pi-cli', () => ({
  useAvailablePiModels: () => ({ data: [] }),
}))
vi.mock('@/services/commandcode-cli', () => ({
  useAvailableCommandCodeModels: () => ({ data: [] }),
}))
vi.mock('@/services/grok-cli', () => ({
  useAvailableGrokModels: () => ({ data: [] }),
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { favorite_models: [], fast_mode_models: [] },
  }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/services/model-catalog', () => ({
  getCatalogModelReasoning: () => undefined,
  getCatalogModelFastInfo: () => ({ supportsFast: false, isFast: false }),
  getCatalogModelOptions: (_catalog: unknown, backend: string) =>
    backend === 'codex'
      ? [{ value: 'gpt-5.5', label: 'GPT 5.5' }]
      : [{ value: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8 (1M)' }],
  useModelCatalog: () => ({ data: undefined }),
  useRefreshModelCatalog: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 390,
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: true,
      media: '(max-width: 767px)',
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

describe('MobileBackendModelPickerSheet', () => {
  it('constrains the bottom sheet and makes the model list the scroll container', () => {
    render(
      <MobileBackendModelPickerSheet
        open
        onOpenChange={vi.fn()}
        selectedBackend="codex"
        selectedProvider={null}
        selectedModel="gpt-5.5"
        installedBackends={['claude', 'codex']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveClass('h-[75svh]', 'min-h-0', 'overflow-hidden')

    const commandList = sheet.querySelector('[data-slot="command-list"]')
    expect(commandList).toHaveClass(
      '!max-h-none',
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
  })
})
