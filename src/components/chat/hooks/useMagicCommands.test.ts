import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@/test/test-utils'
import { useMagicCommands } from './useMagicCommands'
import { useChatStore } from '@/store/chat-store'

function renderUseMagicCommands(
  overrides: Partial<Parameters<typeof useMagicCommands>[0]> = {}
) {
  const handlers: Parameters<typeof useMagicCommands>[0] = {
    handleSaveContext: vi.fn(),
    handleLoadContext: vi.fn(),
    handleLinkedProjects: vi.fn(),
    handleForkSession: vi.fn(),
    handleCommit: vi.fn(),
    handleCommitAndPush: vi.fn(),
    handlePull: vi.fn(),
    handlePush: vi.fn(),
    handleRevertLastCommit: vi.fn(),
    handleOpenPr: vi.fn(),
    handleReview: vi.fn(),
    handleMerge: vi.fn(),
    handleMergePr: vi.fn(),
    handleResolveConflicts: vi.fn(),
    handleInvestigateWorkflowRun: vi.fn(),
    handleInvestigate: vi.fn(),
    handleReviewComments: vi.fn(),
    ...overrides,
  }
  renderHook(() => useMagicCommands(handlers))
  return handlers
}

describe('useMagicCommands review comments batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.getState().setPendingMagicCommand(null)
  })

  it('dispatches the fork session magic command', () => {
    const handlers = renderUseMagicCommands()

    window.dispatchEvent(
      new CustomEvent('magic-command', {
        detail: { command: 'fork-session' },
      })
    )

    expect(handlers.handleForkSession).toHaveBeenCalledTimes(1)
  })

  it('passes separate review comment prompts and plan mode from event detail', () => {
    const handlers = renderUseMagicCommands()

    window.dispatchEvent(
      new CustomEvent('magic-command', {
        detail: {
          command: 'review-comments',
          prompts: ['prompt one', 'prompt two'],
          executionMode: 'plan',
        },
      })
    )

    expect(handlers.handleReviewComments).toHaveBeenCalledWith(
      ['prompt one', 'prompt two'],
      { executionMode: 'plan' }
    )
  })

  it('passes pending separate review comment prompts and plan mode', () => {
    useChatStore.getState().setPendingMagicCommand({
      command: 'review-comments',
      prompts: ['pending one', 'pending two'],
      executionMode: 'plan',
    })

    const handlers = renderUseMagicCommands()

    expect(handlers.handleReviewComments).toHaveBeenCalledWith(
      ['pending one', 'pending two'],
      { executionMode: 'plan' }
    )
  })
})
