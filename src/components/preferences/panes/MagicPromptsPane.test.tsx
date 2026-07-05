import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { defaultPreferences } from '@/types/preferences'
import { MagicPromptsPane } from './MagicPromptsPane'

const mutateMock = vi.fn()
let installedBackendsMock = ['claude', 'codex']

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      ...defaultPreferences,
      magic_prompt_modes: {
        investigate_issue_mode: 'plan',
        investigate_pr_mode: 'plan',
        investigate_workflow_run_mode: 'plan',
        investigate_security_alert_mode: 'plan',
        investigate_advisory_mode: 'plan',
        investigate_linear_issue_mode: 'plan',
        review_comments_mode: 'plan',
        resolve_conflicts_mode: 'yolo',
      },
    },
  }),
  usePatchPreferences: () => ({ mutate: mutateMock }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: installedBackendsMock }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: undefined }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({ data: undefined }),
}))

vi.mock('@/services/commandcode-cli', () => ({
  useAvailableCommandCodeModels: () => ({ data: undefined }),
}))

vi.mock('@/services/pi-cli', () => ({
  useAvailablePiModels: () => ({ data: undefined }),
}))

vi.mock('@/services/grok-cli', () => ({
  useAvailableGrokModels: () => ({ data: undefined }),
}))

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

beforeEach(() => {
  mutateMock.mockReset()
  installedBackendsMock = ['claude', 'codex']
  globalThis.ResizeObserver = ResizeObserverMock as never
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

describe('MagicPromptsPane', () => {
  it('lets chat-style magic prompts choose plan or yolo as their default mode', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Default mode' }))
    await user.click(screen.getByRole('option', { name: 'Yolo' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_modes: expect.objectContaining({
          investigate_issue_mode: 'yolo',
        }),
      })
    )
  })

  it('uses a compact prompt picker on mobile instead of relying only on the sidebar', () => {
    render(<MagicPromptsPane />)

    expect(
      screen.getByRole('combobox', { name: 'Magic prompt' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('magic-prompts-sidebar')).toHaveClass('hidden')
    expect(screen.getByTestId('magic-prompts-sidebar')).toHaveClass('md:block')
  })

  it('does not include release post as an editable magic prompt', () => {
    render(<MagicPromptsPane />)

    expect(screen.queryByText('Release Post')).toBeNull()
  })

  it('lets magic prompts choose Pi, Command Code, and Grok backends', async () => {
    installedBackendsMock = ['claude', 'pi', 'commandcode', 'grok']
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Backend' }))

    expect(screen.getByRole('option', { name: /Pi/i })).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: /Command Code/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Grok/i })).toBeInTheDocument()
  })

  it('keeps magic prompt control labels paired with dropdowns on mobile', () => {
    render(<MagicPromptsPane />)

    expect(screen.getByTestId('magic-prompt-backend-control')).toHaveClass(
      'max-md:w-full'
    )
    expect(screen.getByTestId('magic-prompt-model-control')).toHaveClass(
      'max-md:w-full'
    )
    expect(screen.getByTestId('magic-prompt-mode-control')).toHaveClass(
      'max-md:w-full'
    )
  })
})
