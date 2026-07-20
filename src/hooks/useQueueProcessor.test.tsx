import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useQueueProcessor } from './useQueueProcessor'
import { persistDequeue } from '@/services/chat'
import type { QueuedMessage } from '@/types/chat'

const env = vi.hoisted(() => ({
  isNativeApp: true,
  hasBackend: true,
  wsConnected: true,
}))

const sendMessageMutate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => env.isNativeApp,
  isLocalBackend: () => env.isNativeApp,
  hasBackend: () => env.hasBackend,
}))

vi.mock('@/lib/transport', () => ({
  useWsConnectionStatus: () => env.wsConnected,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))

vi.mock('@/services/chat', () => ({
  useSendMessage: () => ({ mutate: sendMessageMutate }),
  persistDequeue: vi.fn(async () => null),
  persistRequeueFront: vi.fn(async () => []),
  isDuplicateSendError: vi.fn(() => false),
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => env.hasBackend,
}))

const queuedMessage: QueuedMessage = {
  id: 'queue-1',
  message: 'queued prompt',
  pendingImages: [],
  pendingFiles: [],
  pendingSkills: [],
  pendingTextFiles: [],
  model: 'claude-sonnet-4-5',
  provider: null,
  executionMode: 'plan' as const,
  thinkingLevel: 'off',
  queuedAt: Date.now(),
}

describe('useQueueProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.isNativeApp = true
    env.hasBackend = true
    env.wsConnected = true
    useChatStore.setState({
      messageQueues: {},
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
      sessionWorktreeMap: {},
      worktreePaths: {},
    })
  })

  it('does not dequeue queued messages in web access so the backend drain remains owner', async () => {
    env.isNativeApp = false
    useChatStore.setState({
      messageQueues: { 'session-1': [queuedMessage] },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useQueueProcessor())

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(persistDequeue).not.toHaveBeenCalled()
    expect(sendMessageMutate).not.toHaveBeenCalled()
  })

  it('dequeues queued messages in the native app', async () => {
    vi.mocked(persistDequeue).mockResolvedValueOnce(queuedMessage)
    useChatStore.setState({
      messageQueues: { 'session-1': [queuedMessage] },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useQueueProcessor())

    await waitFor(() => {
      expect(persistDequeue).toHaveBeenCalledWith(
        'worktree-1',
        '/tmp/worktree',
        'session-1'
      )
    })
  })
})
