import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactQuery from '@tanstack/react-query'
import { MusePane } from './MusePane'

const patchMutate = vi.fn()
const installMutate = vi.fn()
const updateMutate = vi.fn()
const uninstallMutate = vi.fn()
const openLogin = vi.fn()
const authRefetch = vi.fn()
const pathRefetch = vi.fn()

interface AuthData {
  authenticated: boolean
  error?: string | null
  timedOut?: boolean
}
let authData: AuthData = { authenticated: true }
let statusData = {
  installed: true,
  version: '1.4.10',
  path: '/managed/muse',
}
let preferencesData = {
  muse_cli_source: 'jean',
  selected_muse_model: 'muse/default',
}
let modelsData: { id: string; label: string }[] | undefined

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
  usePreferences: () => ({ data: preferencesData }),
  usePatchPreferences: () => ({ mutate: patchMutate }),
}))

vi.mock('@/services/muse-cli', () => ({
  MUSE_FALLBACK_MODELS: [
    { id: 'muse/default', label: 'Default', isDefault: true },
    { id: 'muse/muse-spark-1.2', label: 'Muse Spark 1.2' },
  ],
  museCliQueryKeys: { all: ['muse-cli'] },
  useMuseCliStatus: () => ({ data: statusData, isLoading: false }),
  useMuseCliAuth: () => ({
    data: authData,
    isLoading: false,
    isFetching: false,
    refetch: authRefetch,
  }),
  useAvailableMuseModels: () => ({ data: modelsData }),
  useMusePathDetection: () => ({
    data: { found: true, path: '/usr/local/bin/muse', version: '1.4.9' },
    isFetching: false,
    refetch: pathRefetch,
  }),
  useInstallMuseCli: () => ({ mutate: installMutate, isPending: false }),
  useUpdateMuseCli: () => ({ mutate: updateMutate, isPending: false }),
  useUninstallMuseCli: () => ({ mutate: uninstallMutate, isPending: false }),
}))

beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

describe('MusePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authData = { authenticated: true }
    statusData = { installed: true, version: '1.4.10', path: '/managed/muse' }
    preferencesData = {
      muse_cli_source: 'jean',
      selected_muse_model: 'muse/default',
    }
    modelsData = undefined
  })

  it('persists PATH source selection', async () => {
    const user = userEvent.setup()
    render(<MusePane />)

    await user.click(screen.getByRole('combobox', { name: 'Muse CLI source' }))
    await user.click(screen.getByRole('option', { name: /System PATH/ }))

    expect(patchMutate).toHaveBeenCalledWith(
      { muse_cli_source: 'path' },
      expect.any(Object)
    )
  })

  it('installs the latest managed release when Muse is not installed', () => {
    statusData = { installed: false, version: '', path: '' }
    render(<MusePane />)

    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install latest' }))

    expect(installMutate).toHaveBeenCalledTimes(1)
    expect(installMutate).toHaveBeenCalledWith('latest')
  })

  it('updates and removes an installed managed release', () => {
    render(<MusePane />)

    expect(screen.queryByRole('button', { name: 'Install latest' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(updateMutate).toHaveBeenCalledTimes(1)
    expect(uninstallMutate).toHaveBeenCalledTimes(1)
    expect(installMutate).not.toHaveBeenCalled()
  })

  it('refreshes PATH detection when the PATH source is selected', () => {
    preferencesData = { ...preferencesData, muse_cli_source: 'path' }
    render(<MusePane />)

    expect(
      screen.getByText('Using /usr/local/bin/muse · 1.4.9')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(pathRefetch).toHaveBeenCalledTimes(1)
  })

  it('starts muse login when signed out', () => {
    authData = { authenticated: false, error: null, timedOut: false }
    render(<MusePane />)

    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(openLogin).toHaveBeenCalledWith('muse', '/managed/muse', [], 'login')
  })

  it('offers relogin once authenticated', () => {
    render(<MusePane />)

    expect(screen.getByText('Authenticated')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Relogin' }))

    expect(openLogin).toHaveBeenCalledWith('muse', '/managed/muse', [], 'login')
  })

  it('hides login until a Muse CLI source is installed', () => {
    statusData = { installed: false, version: '', path: '' }
    render(<MusePane />)

    expect(
      screen.getByText('Select an installed Muse CLI source first.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Login' })).toBeNull()
  })

  it('retries a timed-out auth check without starting login', () => {
    authData = {
      authenticated: false,
      error: 'Muse auth check timed out',
      timedOut: true,
    }
    render(<MusePane />)

    expect(screen.getByText(/Auth check timed out/)).toBeInTheDocument()
    expect(screen.queryByText(/Not authenticated/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(authRefetch).toHaveBeenCalledTimes(1)
    expect(openLogin).not.toHaveBeenCalled()
  })

  it('reports a genuine signed-out state with its error', () => {
    authData = {
      authenticated: false,
      error: 'No stored credentials',
      timedOut: false,
    }
    render(<MusePane />)

    expect(
      screen.getByText('Not authenticated · No stored credentials')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('patches the default model when Muse Spark 1.2 is selected', () => {
    render(<MusePane />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Default model' }), {
      target: { value: 'muse/muse-spark-1.2' },
    })

    expect(patchMutate).toHaveBeenCalledWith({
      selected_muse_model: 'muse/muse-spark-1.2',
    })
  })

  it('lists models reported by the CLI', () => {
    modelsData = [
      { id: 'muse/default', label: 'Default' },
      { id: 'muse/muse-pro-2', label: 'Muse Pro 2' },
    ]
    render(<MusePane />)

    const select = screen.getByRole('combobox', { name: 'Default model' })
    expect(
      Array.from(select.querySelectorAll('option')).map(option => option.value)
    ).toEqual(['muse/default', 'muse/muse-pro-2'])
  })

  it('keeps a saved model selected before the CLI lists it', () => {
    preferencesData = {
      ...preferencesData,
      selected_muse_model: 'muse/muse-pro-2',
    }
    render(<MusePane />)

    expect(screen.getByRole('combobox', { name: 'Default model' })).toHaveValue(
      'muse/muse-pro-2'
    )
  })
})
