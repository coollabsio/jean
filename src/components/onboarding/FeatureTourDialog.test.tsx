import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { FeatureTourDialog } from './FeatureTourDialog'

const mocks = vi.hoisted(() => ({
  patchPreferencesMutate: vi.fn(),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      has_seen_feature_tour: false,
    },
  }),
  usePatchPreferences: () => ({ mutate: mocks.patchPreferencesMutate }),
}))

function renderTour() {
  act(() => {
    useUIStore.setState({ featureTourOpen: true })
  })

  return render(<FeatureTourDialog />)
}

describe('FeatureTourDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useUIStore.setState({ featureTourOpen: false })
    })
  })

  afterEach(() => {
    act(() => {
      useUIStore.setState({ featureTourOpen: false })
    })
  })

  it('opens with Magic Menu automation instead of shortcut memorization', () => {
    renderTour()

    expect(
      screen.getByRole('dialog', { name: /start with the magic menu/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/automate everyday dev tasks/i)).toBeInTheDocument()
    expect(screen.getByText(/commit, push, open prs/i)).toBeInTheDocument()
    expect(screen.getByText(/resolve conflicts/i)).toBeInTheDocument()
  })

  it('teaches every AI backend before keybindings', async () => {
    const user = userEvent.setup()
    renderTour()

    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /next/i }))

    expect(
      screen.getByRole('heading', { name: /bring your favorite ai backend/i })
    ).toBeInTheDocument()
    for (const backend of [
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'Pi',
      'Command Code',
    ]) {
      expect(screen.getByText(backend)).toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(
      screen.getByRole('heading', { name: /mr\. robot/i })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(
      screen.getByRole('heading', { name: /keyboard shortcuts/i })
    ).toBeInTheDocument()
  })

  it('marks the tour as seen when finished', async () => {
    const user = userEvent.setup()
    renderTour()

    for (let i = 0; i < 5; i += 1) {
      await user.click(screen.getByRole('button', { name: /next/i }))
    }
    await user.click(screen.getByRole('button', { name: /done/i }))

    expect(mocks.patchPreferencesMutate).toHaveBeenCalledWith({
      has_seen_feature_tour: true,
    })
    expect(useUIStore.getState().featureTourOpen).toBe(false)
  })
})
