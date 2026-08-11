import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import type { QueuedMessage } from '@/types/chat'
import type { Worktree } from '@/types/projects'

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  start: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invoke }))

vi.mock('./new-session-flow', () => ({
  finishNewSessionFlow: mocks.finish,
  startNewSessionPrompt: mocks.start,
}))

import {
  sendRecoveredSetupMessage,
  usePendingSetupMessageRecovery,
} from './usePendingSetupMessageRecovery'

const worktree = {
  id: 'worktree-1',
  path: '/repo/worktree-1',
  project_id: 'project-1',
  name: 'worktree-1',
} as Worktree

const message = {
  id: 'message-1',
  message: 'Resume after reload',
  pendingImages: [],
  pendingFiles: [],
  pendingSkills: [],
  pendingTextFiles: [],
  model: 'gpt-5.6-sol',
  provider: null,
  executionMode: 'yolo',
  thinkingLevel: 'high',
  backend: 'codex',
  queuedAt: 1,
} as QueuedMessage

describe('sendRecoveredSetupMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sendingSessionIds: {},
      selectedBackends: {},
      selectedModels: {},
      executionModes: {},
      lastSentMessages: {},
      pendingSetupPrompts: {},
      pendingSetupMessages: {},
      recoverableSetupMessageIds: {},
    })
    mocks.finish.mockResolvedValue({
      worktree,
      session: { id: 'session-1' },
    })
    mocks.start.mockResolvedValue(undefined)
  })

  it('automatically resumes and clears a message restored from disk', async () => {
    mocks.invoke.mockResolvedValue({
      ...worktree,
      setup_script: 'bun install',
      setup_success: true,
    })
    act(() => {
      const store = useChatStore.getState()
      store.setPendingSetupMessage(worktree.id, message)
      store.restorePendingSetupRecovery(worktree.id)
    })

    renderHook(() => usePendingSetupMessageRecovery())

    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    expect(mocks.invoke).toHaveBeenCalledWith('get_worktree', {
      worktreeId: worktree.id,
    })
    expect(
      useChatStore.getState().pendingSetupMessages[worktree.id]
    ).toBeUndefined()
    expect(
      useChatStore.getState().recoverableSetupMessageIds[worktree.id]
    ).toBeUndefined()
  })

  it('recreates the session settings and sends the exact queued message', async () => {
    await expect(
      sendRecoveredSetupMessage(worktree, message)
    ).resolves.toMatchObject({ id: 'session-1' })

    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingWorktree: worktree,
        queuedMessage: message,
      })
    )
    expect(mocks.start).toHaveBeenCalledWith(
      expect.any(Function),
      worktree,
      expect.objectContaining({ id: 'session-1' }),
      message
    )
    const state = useChatStore.getState()
    expect(state.selectedBackends['session-1']).toBe('codex')
    expect(state.selectedModels['session-1']).toBe('gpt-5.6-sol')
    expect(state.executionModes['session-1']).toBe('yolo')
    expect(state.lastSentMessages['session-1']).toBe('Resume after reload')
    expect(state.sendingSessionIds['session-1']).toBeUndefined()
  })

  it('always releases the sending state when recovery fails', async () => {
    mocks.start.mockRejectedValue(new Error('offline'))

    await expect(sendRecoveredSetupMessage(worktree, message)).rejects.toThrow(
      'offline'
    )
    expect(
      useChatStore.getState().sendingSessionIds['session-1']
    ).toBeUndefined()
  })

  it('discards recovery state when its worktree no longer exists', async () => {
    mocks.invoke.mockRejectedValue(
      new Error('Worktree not found: worktree-1')
    )
    act(() => {
      const store = useChatStore.getState()
      store.setPendingSetupMessage(worktree.id, message)
      store.restorePendingSetupRecovery(worktree.id)
    })

    renderHook(() => usePendingSetupMessageRecovery())

    await waitFor(() => {
      expect(
        useChatStore.getState().pendingSetupMessages[worktree.id]
      ).toBeUndefined()
    })
    expect(
      useChatStore.getState().recoverableSetupMessageIds[worktree.id]
    ).toBeUndefined()
    expect(mocks.invoke).toHaveBeenCalledOnce()
  })
})
