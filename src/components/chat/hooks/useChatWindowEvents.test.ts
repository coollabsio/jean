import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useChatWindowEvents } from './useChatWindowEvents'
import { useUIStore } from '@/store/ui-store'

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/services/chat', () => ({
  cancelChatMessage: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => false,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

describe('useChatWindowEvents worktree approval shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
  })

  function renderUseChatWindowEvents(
    overrides: Partial<Parameters<typeof useChatWindowEvents>[0]> = {}
  ) {
    const inputRef = { current: null }
    const scrollViewportRef = { current: null }

    const params: Parameters<typeof useChatWindowEvents>[0] = {
      inputRef,
      activeSessionId: 'session-1',
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/tmp/worktree-1',
      isModal: false,
      latestPlanContent: null,
      latestPlanFilePath: null,
      setPlanDialogContent: vi.fn(),
      setIsPlanDialogOpen: vi.fn(),
      session: null,
      isRecapDialogOpen: false,
      recapDialogDigest: null,
      setRecapDialogDigest: vi.fn(),
      setIsRecapDialogOpen: vi.fn(),
      setIsGeneratingRecap: vi.fn(),
      gitStatus: null,
      setDiffRequest: vi.fn(),
      isAtBottom: true,
      scrollToBottom: vi.fn(),
      currentStreamingContentBlocks: [],
      isSending: false,
      currentQueuedMessages: [],
      createSession: {
        mutate: vi.fn(),
      },
      preferences: undefined,
      patchPreferences: {
        mutate: vi.fn(),
      },
      handleSaveContext: vi.fn(),
      handleLoadContext: vi.fn(),
      runScripts: [],
      hasPendingPlanApproval: true,
      pendingPlanMessage: { id: 'msg-1' },
      handlePlanApproval: vi.fn(),
      handlePlanApprovalYolo: vi.fn(),
      handleClearContextApproval: vi.fn(),
      handleClearContextApprovalBuild: vi.fn(),
      handleWorktreeBuildApproval: vi.fn(),
      handleWorktreeYoloApproval: vi.fn(),
      scrollViewportRef,
      beginKeyboardScroll: vi.fn(),
      endKeyboardScroll: vi.fn(),
      ...overrides,
    }

    renderHook(() => useChatWindowEvents(params))
    return params
  }

  it('handles worktree build approval for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))

    expect(params.handleWorktreeBuildApproval).toHaveBeenCalledWith('msg-1')
  })

  it('handles plan approval for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan'))

    expect(params.handlePlanApproval).toHaveBeenCalledWith('msg-1')
  })

  it('handles yolo approval for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-yolo'))

    expect(params.handlePlanApprovalYolo).toHaveBeenCalledWith('msg-1')
  })

  it('handles clear-context and worktree approvals for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-clear-context'))
    window.dispatchEvent(new CustomEvent('approve-plan-clear-context-build'))
    window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))
    window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))

    expect(params.handleClearContextApproval).toHaveBeenCalledWith('msg-1')
    expect(params.handleClearContextApprovalBuild).toHaveBeenCalledWith('msg-1')
    expect(params.handleWorktreeBuildApproval).toHaveBeenCalledWith('msg-1')
    expect(params.handleWorktreeYoloApproval).toHaveBeenCalledWith('msg-1')
  })

  it('ignores worktree yolo approval while plan is still streaming', () => {
    const params = renderUseChatWindowEvents({
      hasPendingPlanApproval: false,
    })

    window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))

    expect(params.handleWorktreeYoloApproval).not.toHaveBeenCalled()
  })

  it('ignores approval shortcuts while plan is still streaming', () => {
    const params = renderUseChatWindowEvents({
      hasPendingPlanApproval: false,
    })

    window.dispatchEvent(new CustomEvent('approve-plan'))

    expect(params.handlePlanApproval).not.toHaveBeenCalled()
    expect(params.handleWorktreeYoloApproval).not.toHaveBeenCalled()
  })

  it('ignores worktree approval shortcuts in non-modal chat when a session modal is open', () => {
    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'worktree-2',
    })

    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))
    window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))

    expect(params.handleWorktreeBuildApproval).not.toHaveBeenCalled()
    expect(params.handleWorktreeYoloApproval).not.toHaveBeenCalled()
  })
})
