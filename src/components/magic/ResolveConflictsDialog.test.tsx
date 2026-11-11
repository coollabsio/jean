import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppPreferences } from '@/types/preferences'
import { ResolveConflictsDialog } from './ResolveConflictsDialog'

const prefsState: { value: Partial<AppPreferences> } = { value: {} }

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: prefsState.value }),
}))
vi.mock('@/services/projects', () => ({
  useWorktree: () => ({ data: null }),
  useProjects: () => ({ data: [] }),
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: INSTALLED }),
}))
vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: undefined }),
}))
vi.mock('@/services/grok-cli', () => ({
  useAvailableGrokModels: () => ({ data: undefined }),
}))
vi.mock('@/services/kimi-cli', () => ({
  useAvailableKimiModels: () => ({ data: undefined }),
}))
vi.mock('@/services/antigravity-cli', () => ({
  useAvailableAntigravityModels: () => ({ data: undefined }),
}))
vi.mock('@/services/model-catalog', async () => ({
  ...(await vi.importActual<object>('@/services/model-catalog')),
  useModelCatalog: () => ({ data: undefined }),
}))
vi.mock('@/services/muse-cli', () => ({
  useAvailableMuseModels: () => ({ data: undefined }),
}))

const INSTALLED = ['claude', 'grok'] as const

const basePrefs = (): Partial<AppPreferences> => ({
  default_backend: 'claude',
})

describe('ResolveConflictsDialog', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
    prefsState.value = basePrefs()
  })

  it('keeps the chosen backend when preferences refetch before confirm', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <ResolveConflictsDialog
        open
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
      />
    )

    await user.click(screen.getByLabelText(/Choose backend \+ model/))
    const dialog = screen.getByRole('dialog')
    const [backendSelect] = within(dialog).getAllByRole('combobox')
    if (!backendSelect) throw new Error('backend select not rendered')
    await user.click(backendSelect)
    await user.click(await screen.findByRole('option', { name: /Grok/ }))

    // A refetch returns equal data in a new object.
    prefsState.value = basePrefs()
    rerender(
      <ResolveConflictsDialog
        open
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Resolve conflicts' }))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'grok',
        model: expect.stringMatching(/^grok\//),
      })
    )
  })
})
