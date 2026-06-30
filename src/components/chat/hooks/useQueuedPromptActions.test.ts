import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useQueuedPromptActions } from './useQueuedPromptActions'
import { useChatStore } from '@/store/chat-store'
import {
  cancelChatMessage,
  persistMoveQueuedFront,
  persistRemoveQueued,
  persistUpdateQueued,
  steerCodexTurn,
  steerOpencodeTurn,
  steerPiTurn,
} from '@/services/chat'
import type { QueuedMessage } from '@/types/chat'

vi.mock('@/services/chat', () => ({
  cancelChatMessage: vi.fn().mockResolvedValue(true),
  persistMoveQueuedFront: vi.fn().mockResolvedValue(true),
  persistRemoveQueued: vi.fn(),
  persistUpdateQueued: vi.fn().mockResolvedValue(true),
  steerCodexTurn: vi.fn().mockResolvedValue(undefined),
  steerOpencodeTurn: vi.fn().mockResolvedValue(undefined),
  steerPiTurn: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn() },
}))

const createMessage = (
  id: string,
  overrides?: Partial<QueuedMessage>
): QueuedMessage => ({
  id,
  message: `prompt ${id}`,
  pendingImages: [],
  pendingFiles: [],
  pendingSkills: [],
  pendingTextFiles: [],
  model: 'sonnet',
  provider: null,
  executionMode: 'plan',
  thinkingLevel: 'off',
  queuedAt: 0,
  ...overrides,
})

describe('useQueuedPromptActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(persistMoveQueuedFront).mockResolvedValue(true)
    vi.mocked(persistUpdateQueued).mockResolvedValue(true)
    vi.mocked(steerCodexTurn).mockResolvedValue(undefined)
    vi.mocked(steerOpencodeTurn).mockResolvedValue(undefined)
    vi.mocked(steerPiTurn).mockResolvedValue(undefined)
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1'),
          createMessage('msg-2'),
          createMessage('msg-3'),
        ],
      },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree-1' },
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
      selectedBackends: {},
    })
  })

  it('removes a queued message locally and persists removal', () => {
    const { result } = renderHook(() => useQueuedPromptActions())

    act(() => {
      result.current.handleRemoveQueuedMessage('session-1', 'msg-2')
    })

    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-3'])
    expect(persistRemoveQueued).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree-1',
      'session-1',
      'msg-2'
    )
  })

  it('edits a queued message locally and persists update', async () => {
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleEditQueuedMessage(
        'session-1',
        'msg-2',
        'updated prompt'
      )
    })

    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.message)
    ).toEqual(['prompt msg-1', 'updated prompt', 'prompt msg-3'])
    expect(persistUpdateQueued).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree-1',
      'session-1',
      'msg-2',
      'updated prompt'
    )
  })

  it('drops the stale local copy when the queued message was already dequeued', async () => {
    vi.mocked(persistUpdateQueued).mockResolvedValue(false)
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleEditQueuedMessage(
        'session-1',
        'msg-2',
        'updated prompt'
      )
    })

    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.message)
    ).toEqual(['prompt msg-1', 'prompt msg-3'])
  })

  it('does not edit queued messages that can be steered', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [createMessage('msg-1', { backend: 'codex' })],
      },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleEditQueuedMessage(
        'session-1',
        'msg-1',
        'updated prompt'
      )
    })

    expect(persistUpdateQueued).not.toHaveBeenCalled()
    expect(useChatStore.getState().messageQueues['session-1']?.[0]?.message).toBe(
      'prompt msg-1'
    )
  })

  it('idle session: promotes the message and force-processes the queue', async () => {
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(persistMoveQueuedFront).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree-1',
      'session-1',
      'msg-2'
    )
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('idle session: aborts when another client already dequeued the message', async () => {
    vi.mocked(persistMoveQueuedFront).mockResolvedValue(false)
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })

  it('busy codex session: steers the running turn and removes the message', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'codex' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(steerCodexTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'prompt msg-2'
    )
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-3'])
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy codex session: falls back to cancel+send when steering fails', async () => {
    vi.mocked(steerCodexTurn).mockRejectedValue(new Error('turn ended'))
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'codex' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(persistMoveQueuedFront).toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy codex session with attachments: steers the running turn', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            pendingImages: [{ id: 'img-1', path: '/tmp/img.png' }] as never,
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'codex' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerCodexTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'prompt msg-1',
      expect.objectContaining({ id: 'msg-1' })
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy pi session: steers the running turn and removes the message', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(steerPiTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'prompt msg-2'
    )
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-3'])
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy pi session: falls back to cancel+send when steering fails', async () => {
    vi.mocked(steerPiTurn).mockRejectedValue(new Error('host unavailable'))
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(persistMoveQueuedFront).toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy opencode session: steers the running turn and removes the message', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'opencode' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(steerOpencodeTurn).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree-1',
      'session-1',
      'prompt msg-2'
    )
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-3'])
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy opencode session: falls back to cancel+send when steering fails', async () => {
    vi.mocked(steerOpencodeTurn).mockRejectedValue(new Error('session missing'))
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'opencode' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(persistMoveQueuedFront).toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy opencode session with attachments: skips steer, cancels instead', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            pendingTextFiles: [
              { id: 'txt-1', path: '/tmp/input.txt' },
            ] as never,
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'opencode' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerOpencodeTurn).not.toHaveBeenCalled()
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy pi session with attachments: skips steer, cancels instead', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            pendingFiles: [{ id: 'file-1', path: '/tmp/file.txt' }] as never,
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerPiTurn).not.toHaveBeenCalled()
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy claude session: promotes to front and cancels the run', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-3', 'msg-1', 'msg-2'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy claude session: does not cancel when another client won the race', async () => {
    vi.mocked(persistMoveQueuedFront).mockResolvedValue(false)
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('waiting-for-input session: promotes and force-processes without cancelling', async () => {
    useChatStore.setState({
      waitingForInputSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(cancelChatMessage).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    // Waiting flag cleared so the queue processor can send
    expect(
      useChatStore.getState().waitingForInputSessionIds['session-1']
    ).toBeUndefined()
  })

  it('unknown queued message id is a no-op', async () => {
    const { result } = renderHook(() => useQueuedPromptActions())

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'unknown')
    })

    expect(persistMoveQueuedFront).not.toHaveBeenCalled()
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })
})
