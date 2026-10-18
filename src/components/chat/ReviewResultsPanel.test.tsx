import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { useChatStore } from '@/store/chat-store'
import { ReviewResultsPanel } from './ReviewResultsPanel'
import type { ReviewResponse } from '@/types/projects'
import {
  DEFAULT_MAGIC_PROMPT_MODES,
  defaultPreferences,
} from '@/types/preferences'

let isMobile = false
let preferencesMock = { ...defaultPreferences }

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: preferencesMock }),
}))

describe('ReviewResultsPanel', () => {
  beforeEach(() => {
    isMobile = false
    preferencesMock = {
      ...defaultPreferences,
      magic_prompt_modes: { ...DEFAULT_MAGIC_PROMPT_MODES },
    }
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.hasPointerCapture ??= vi.fn(() => false)
    Element.prototype.setPointerCapture ??= vi.fn()
    Element.prototype.releasePointerCapture ??= vi.fn()
    useChatStore.setState({
      reviewResults: {},
      fixedReviewFindings: {},
      reviewSidebarVisible: false,
    })
  })

  it('shows review metadata and failure scenario for structured findings when expanded', async () => {
    const reviewResults: ReviewResponse = {
      summary: 'One high-confidence correctness issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          category: 'correctness',
          confidence: 'high',
          blocking: true,
          introduced_by_diff: true,
          file: 'src/App.tsx',
          line: 42,
          title: 'Null access after guard removal',
          description:
            'The new code dereferences value after removing a guard.',
          failure_scenario: 'When value is null, rendering throws.',
          suggestion: 'Restore the null guard before dereferencing value.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    // Collapsed by default — expand via the title control inside the row
    const row = screen.getByTestId('review-finding-row-0')
    await userEvent.click(
      within(row).getByRole('button', {
        name: /null access after guard removal/i,
      })
    )

    expect(screen.getByText('Correctness')).toBeInTheDocument()
    expect(screen.getByText('High confidence')).toBeInTheDocument()
    expect(screen.getByText('Blocking')).toBeInTheDocument()
    expect(screen.getByText('Introduced by diff')).toBeInTheDocument()
    expect(screen.getByText('Failure Scenario')).toBeInTheDocument()
    expect(
      screen.getByText('When value is null, rendering throws.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/praise/i)).not.toBeInTheDocument()
  })

  it('shows a running indicator while the review is in progress', () => {
    render(<ReviewResultsPanel sessionId="session-1" isReviewing />)

    expect(screen.getByText('Review running...')).toBeInTheDocument()
    expect(screen.queryByText('No review results')).not.toBeInTheDocument()
  })

  it('switches between grouped reviews using backend and model labels', async () => {
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          result: {
            summary: 'Codex review',
            approval_status: 'changes_requested',
            findings: [
              {
                severity: 'warning',
                file: 'src/codex.ts',
                title: 'Codex finding',
                description: 'Found by Codex.',
              },
            ],
          },
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          result: {
            summary: 'Claude review',
            approval_status: 'approved',
            findings: [
              {
                severity: 'suggestion',
                file: 'src/claude.ts',
                title: 'Claude finding',
                description: 'Found by Claude.',
              },
            ],
          },
        },
      ],
    } as never)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(screen.getByText('Codex finding')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(
      screen.getByRole('option', { name: 'Claude · claude-fable-5' })
    )
    expect(screen.getByText('Claude finding')).toBeInTheDocument()
  })

  it('falls back to the first available review after changing sessions', async () => {
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          result: {
            summary: 'Codex review',
            approval_status: 'approved',
            findings: [],
          },
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          result: {
            summary: 'Claude review',
            approval_status: 'approved',
            findings: [],
          },
        },
      ],
    } as never)
    useChatStore.getState().setReviewResults('session-2', {
      reviews: [
        {
          backend: 'opencode',
          model: 'big-pickle',
          result: {
            summary: 'OpenCode review for the new session',
            approval_status: 'approved',
            findings: [
              {
                severity: 'suggestion',
                file: 'src/new-session.ts',
                title: 'New session finding',
                description: 'Found in the newly selected session.',
              },
            ],
          },
        },
      ],
    } as never)

    const { rerender } = render(
      <ReviewResultsPanel sessionId="session-1" />
    )
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(
      screen.getByRole('option', { name: 'Claude · claude-fable-5' })
    )

    rerender(<ReviewResultsPanel sessionId="session-2" />)

    expect(screen.getByText('New session finding')).toBeInTheDocument()
  })

  it('shows a loading status for a grouped review that is still running', () => {
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          status: 'running',
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          status: 'running',
        },
      ],
    } as never)

    render(<ReviewResultsPanel sessionId="session-1" isReviewing />)

    expect(screen.getByRole('combobox')).toHaveTextContent(
      /Codex · gpt-5\.6-sol.*Running/
    )
  })

  it('does not show a close button for code review results', () => {
    const reviewResults: ReviewResponse = {
      summary: 'No findings.',
      approval_status: 'approved',
      findings: [],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(
      screen.queryByRole('button', { name: 'Close' })
    ).not.toBeInTheDocument()
  })

  it('renders a simple list layout without master-detail resizable panels', () => {
    isMobile = true
    const reviewResults: ReviewResponse = {
      summary: 'One issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/components/chat/hooks/useGitOperations.ts',
          title: 'Review completion event can be missed',
          description: 'The frontend can miss a fast completion event.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    const { container } = render(<ReviewResultsPanel sessionId="session-1" />)

    expect(
      container.querySelector('[data-panel-group-direction]')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Review Findings')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /send to chat/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /send separately/i })
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /send (to chat|separately)/i })
    ).toEqual([
      screen.getByRole('button', { name: /send to chat/i }),
      screen.getByRole('button', { name: /send separately/i }),
    ])
  })

  it('sends selected findings combined or separately', async () => {
    const onSendFix = vi.fn()
    const reviewResults: ReviewResponse = {
      summary: 'Two issues found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'First finding',
          description: 'First finding details.',
          suggestion: 'Fix first',
        },
        {
          severity: 'critical',
          file: 'src/App.tsx',
          title: 'Second finding',
          description: 'Second finding details.',
          suggestion: 'Fix second',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" onSendFix={onSendFix} />)

    // All fixable findings selected by default
    expect(
      screen.getByRole('button', { name: /send to chat \(2\)/i })
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: /send to chat \(2\)/i })
    )
    expect(onSendFix).toHaveBeenCalledTimes(1)
    const combinedCall = onSendFix.mock.calls[0]
    expect(combinedCall?.[0]).toContain(
      'Fix the following 2 code review findings'
    )
    expect(combinedCall?.[0]).toContain('First finding')
    expect(combinedCall?.[0]).toContain('Second finding')
    expect(combinedCall?.[1]).toBe('plan')

    onSendFix.mockClear()

    await userEvent.click(
      screen.getByRole('button', { name: /send separately \(2\)/i })
    )
    expect(onSendFix).toHaveBeenCalledTimes(1)
    const separateCall = onSendFix.mock.calls[0]
    expect(Array.isArray(separateCall?.[0])).toBe(true)
    const separateMessages = separateCall?.[0] as string[]
    expect(separateMessages).toHaveLength(2)
    // Sorted by severity: critical (Second) before warning (First)
    expect(separateMessages[0]).toContain('Second finding')
    expect(separateMessages[1]).toContain('First finding')
    expect(separateCall?.[1]).toBe('plan')
  })

  it('uses cmd+enter for separate chats and shift+cmd+enter for one chat', async () => {
    const onSendFix = vi.fn()
    useChatStore.getState().setReviewResults('session-1', {
      summary: 'Two issues found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/first.ts',
          title: 'First',
          description: 'First details.',
        },
        {
          severity: 'warning',
          file: 'src/second.ts',
          title: 'Second',
          description: 'Second details.',
        },
      ],
    })

    render(<ReviewResultsPanel sessionId="session-1" onSendFix={onSendFix} />)

    screen.getByRole('region', { name: /review findings/i }).focus()
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    expect(Array.isArray(onSendFix.mock.calls[0]?.[0])).toBe(true)

    onSendFix.mockClear()
    await userEvent.keyboard('{Shift>}{Meta>}{Enter}{/Meta}{/Shift}')
    expect(typeof onSendFix.mock.calls[0]?.[0]).toBe('string')
  })

  it('uses the selected reviewer fix_mode when sending findings', async () => {
    preferencesMock = {
      ...defaultPreferences,
      magic_prompt_modes: {
        ...DEFAULT_MAGIC_PROMPT_MODES,
        code_review_fix_mode: 'plan',
      },
      magic_code_review_configs: [
        {
          backend: 'claude',
          model: 'claude-fable-5',
          fix_mode: 'plan',
        },
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          fix_mode: 'yolo',
        },
      ],
    }
    const onSendFix = vi.fn()
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'claude',
          model: 'claude-fable-5',
          status: 'completed',
          result: {
            summary: 'Claude findings.',
            approval_status: 'changes_requested',
            findings: [
              {
                severity: 'warning',
                file: 'src/App.tsx',
                title: 'Claude finding',
                description: 'Details.',
                suggestion: 'Fix it',
              },
            ],
          },
        },
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          status: 'completed',
          result: {
            summary: 'Codex findings.',
            approval_status: 'changes_requested',
            findings: [
              {
                severity: 'warning',
                file: 'src/lib.ts',
                title: 'Codex finding',
                description: 'Details.',
                suggestion: 'Fix it',
              },
            ],
          },
        },
      ],
    } as never)

    render(<ReviewResultsPanel sessionId="session-1" onSendFix={onSendFix} />)

    await userEvent.click(
      screen.getByRole('button', { name: /send to chat \(1\)/i })
    )
    expect(onSendFix).toHaveBeenCalledWith(expect.any(String), 'plan', {
      backend: 'claude',
      model: 'claude-fable-5',
    })

    onSendFix.mockClear()
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(
      screen.getByRole('option', { name: 'Codex · gpt-5.6-sol' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: /send to chat \(1\)/i })
    )
    expect(onSendFix).toHaveBeenCalledWith(expect.any(String), 'yolo', {
      backend: 'codex',
      model: 'gpt-5.6-sol',
    })
  })

  it('falls back to global code_review_fix_mode when reviewer has no fix_mode', async () => {
    preferencesMock = {
      ...defaultPreferences,
      magic_prompt_modes: {
        ...DEFAULT_MAGIC_PROMPT_MODES,
        code_review_fix_mode: 'yolo',
      },
      magic_code_review_configs: [
        {
          backend: 'claude',
          model: 'claude-fable-5',
        },
      ],
    }
    const onSendFix = vi.fn()
    const reviewResults: ReviewResponse = {
      summary: 'One issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'Finding',
          description: 'Details.',
          suggestion: 'Fix it',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)
    render(<ReviewResultsPanel sessionId="session-1" onSendFix={onSendFix} />)

    await userEvent.click(
      screen.getByRole('button', { name: /send to chat \(1\)/i })
    )
    expect(onSendFix).toHaveBeenCalledWith(
      expect.any(String),
      'yolo',
      undefined
    )
  })

  it('supports select all / deselect all', async () => {
    const reviewResults: ReviewResponse = {
      summary: 'Two issues found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'First finding',
          description: 'First finding details.',
        },
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'Second finding',
          description: 'Second finding details.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /deselect all/i }))
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /send to chat \(0\)/i })
    ).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: /select all/i }))
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
  })

  it('expands a finding row to show description details', async () => {
    const reviewResults: ReviewResponse = {
      summary: 'Two issues found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'First finding',
          description: 'First finding details.',
        },
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'Second finding',
          description: 'Second finding details.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    // Description hidden until expanded
    expect(
      screen.queryByText('Second finding details.')
    ).not.toBeInTheDocument()

    const secondRow = screen.getByTestId('review-finding-row-1')
    await userEvent.click(
      within(secondRow).getByRole('button', { name: /second finding/i })
    )

    expect(screen.getByText('Second finding details.')).toBeInTheDocument()
  })
})
