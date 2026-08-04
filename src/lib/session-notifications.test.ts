import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => chatState,
  },
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => uiState,
  },
}))

let chatState: {
  activeWorktreeId: string | null
  activeSessionIds: Record<string, string>
  sessionWorktreeMap: Record<string, string>
}

let uiState: {
  sessionChatModalOpen: boolean
  sessionChatModalWorktreeId: string | null
}

describe('session-notifications', () => {
  beforeEach(() => {
    invoke.mockClear()
    chatState = {
      activeWorktreeId: 'wt-other',
      activeSessionIds: { 'wt-1': 'session-1', 'wt-other': 'session-other' },
      sessionWorktreeMap: { 'session-1': 'wt-1', 'session-other': 'wt-other' },
    }
    uiState = {
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    }
    // Focused window by default
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true,
    })
  })

  it('notifies when focused on a different session (issue #626)', async () => {
    const { notifySessionNeedsAttention } = await import(
      './session-notifications'
    )
    notifySessionNeedsAttention('session-1', 'Needs your input', 'My session')
    expect(invoke).toHaveBeenCalledWith('send_native_notification', {
      title: 'Needs your input',
      body: 'My session',
    })
  })

  it('skips OS banner when the session is actively viewed and window focused', async () => {
    chatState.activeWorktreeId = 'wt-1'
    const { notifySessionNeedsAttention } = await import(
      './session-notifications'
    )
    notifySessionNeedsAttention('session-1', 'Needs your input', 'My session')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('notifies when window is unfocused even if session is active', async () => {
    chatState.activeWorktreeId = 'wt-1'
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    })
    const { notifySessionNeedsAttention } = await import(
      './session-notifications'
    )
    notifySessionNeedsAttention('session-1', 'Needs your input', 'My session')
    expect(invoke).toHaveBeenCalledWith('send_native_notification', {
      title: 'Needs your input',
      body: 'My session',
    })
  })
})
