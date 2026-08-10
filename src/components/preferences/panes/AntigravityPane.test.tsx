import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactQuery from '@tanstack/react-query'
import { AntigravityPane } from './AntigravityPane'

const patchMutate = vi.fn()
const installMutate = vi.fn()
const uninstallMutate = vi.fn()
const openLogin = vi.fn()

vi.mock('@/store/ui-store', () => ({
  useUIStore: (
    selector: (state: { openCliLoginModal: typeof openLogin }) => unknown
  ) => selector({ openCliLoginModal: openLogin }),
}))

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      antigravity_cli_source: 'jean',
      selected_antigravity_model: 'antigravity/auto',
    },
  }),
  usePatchPreferences: () => ({ mutate: patchMutate }),
}))

vi.mock('@/services/antigravity-cli', () => ({
  antigravityCliQueryKeys: { all: ['antigravity-cli'] },
  useAntigravityCliStatus: () => ({
    data: { installed: true, version: '0.54.4', path: '/managed/antigravity' },
  }),
  useAntigravityCliAuth: () => ({ data: { authenticated: true } }),
  useAvailableAntigravityModels: () => ({ data: [{ id: 'auto', label: 'Auto' }] }),
  useAvailableAntigravityVersions: () => ({
    data: [
      { version: '0.54.4', prerelease: false },
      { version: '0.55.0-preview', prerelease: true },
    ],
    isFetching: false,
  }),
  useAntigravityPathDetection: () => ({
    data: { found: true, path: '/usr/local/bin/antigravity', version: '0.53.0' },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useInstallAntigravityCli: () => ({ mutate: installMutate, isPending: false }),
  useUninstallAntigravityCli: () => ({
    mutate: uninstallMutate,
    isPending: false,
  }),
}))

describe('AntigravityPane', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows Jean-managed and system PATH sources', () => {
    render(<AntigravityPane />)

    expect(screen.getByText('Jean managed')).toBeInTheDocument()
    expect(screen.getByText('System PATH')).toBeInTheDocument()
    expect(screen.getByText(/\/usr\/local\/bin\/antigravity/)).toBeInTheDocument()
  })

  it('installs the selected stable managed version', () => {
    render(<AntigravityPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Install version' }))

    expect(installMutate).toHaveBeenCalledWith('0.54.4')
    expect(screen.queryByText('0.55.0-preview')).not.toBeInTheDocument()
  })

  it('persists PATH source selection', () => {
    render(<AntigravityPane />)

    const pathLabel = screen.getByText('System PATH').closest('label')
    expect(pathLabel).not.toBeNull()
    if (!pathLabel) return
    fireEvent.click(pathLabel)

    expect(patchMutate).toHaveBeenCalledWith(
      { antigravity_cli_source: 'path' },
      expect.any(Object)
    )
  })

  it('opens the selected Antigravity binary in the interactive login terminal', () => {
    render(<AntigravityPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Relogin' }))

    expect(openLogin).toHaveBeenCalledWith(
      'antigravity',
      '/managed/antigravity',
      [],
      'login'
    )
  })
})
