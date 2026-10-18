import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { FeatureTourDialog } from './FeatureTourDialog'

const mocks = vi.hoisted(() => ({
  patchPreferencesMutate: vi.fn(),
  preferences: undefined as { has_seen_feature_tour: boolean } | undefined,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mocks.preferences }),
  usePatchPreferences: () => ({ mutate: mocks.patchPreferencesMutate }),
}))

vi.mock('@/lib/environment', () => ({ isNativeApp: () => true }))

function renderTour() {
  act(() => useUIStore.setState({ featureTourOpen: true }))
  return render(<FeatureTourDialog />)
}

describe('FeatureTourDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preferences = { has_seen_feature_tour: false }
    act(() => useUIStore.setState({ featureTourOpen: false }))
  })

  afterEach(() => {
    act(() => useUIStore.setState({ featureTourOpen: false }))
  })

  it('starts with a compact page about the Magic Menu', () => {
    renderTour()

    expect(
      screen.getByRole('dialog', { name: /meet the magic menu/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/make it your first stop/i)).toBeInTheDocument()
    expect(screen.getByText(/use the magic menu often/i)).toBeInTheDocument()
    expect(document.querySelector('kbd')).toHaveTextContent(/M/i)
    expect(screen.getByText(/commit, push/i)).toBeInTheDocument()
    expect(screen.getByText(/resolve conflicts/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
  })

  it('shows a brief jean.json page and then marks the tour as seen', async () => {
    const user = userEvent.setup()
    renderTour()

    await user.click(screen.getByRole('button', { name: /next/i }))

    expect(
      screen.getByRole('heading', { name: /automate with jean\.json/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/prepares each new worktree/i)).toBeInTheDocument()
    expect(
      screen.getByText(/starts your development environment/i)
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /got it/i }))

    expect(mocks.patchPreferencesMutate).toHaveBeenCalledWith({
      has_seen_feature_tour: true,
    })
    expect(useUIStore.getState().featureTourOpen).toBe(false)
  })

  it('marks the tour as seen with the close button before preferences load', async () => {
    const user = userEvent.setup()
    mocks.preferences = undefined
    renderTour()

    await user.click(screen.getByRole('button', { name: /close/i }))

    expect(mocks.patchPreferencesMutate).toHaveBeenCalledWith({
      has_seen_feature_tour: true,
    })
    expect(useUIStore.getState().featureTourOpen).toBe(false)
  })

  it('can be acknowledged with Enter', async () => {
    const user = userEvent.setup()
    renderTour()

    await user.keyboard('{Enter}')

    expect(
      screen.getByRole('heading', { name: /automate with jean\.json/i })
    ).toBeInTheDocument()

    await user.keyboard('{Enter}')

    expect(useUIStore.getState().featureTourOpen).toBe(false)
  })
})
