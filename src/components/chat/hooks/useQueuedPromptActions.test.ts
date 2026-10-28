import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  saveQueuedMessageEdit,
  useQueuedPromptActions,
} from './useQueuedPromptActions'
import { useChatStore } from '@/store/chat-store'
import {
  cancelChatMessage,
  persistMoveQueuedFront,
  persistRemoveQueued,
  persistUpdateQueued,
  steerCodexTurn,
  steerGrokTurn,
  steerOpencodeTurn,
  steerPiTurn,
  steerClaudeTurn,
} from '@/services/chat'
import { queryClient } from '@/lib/query-client'
import { preferencesQueryKeys } from '@/services/preferences'
import type { QueuedMessage } from '@/types/chat'

vi.mock('@/services/chat', () => ({
  cancelChatMessage: vi.fn().mockResolvedValue(true),
  persistMoveQueuedFront: vi.fn().mockResolvedValue(true),
  persistRemoveQueued: vi.fn(),
  persistUpdateQueued: vi.fn().mockResolvedValue(true),
  steerCodexTurn: vi.fn().mockResolvedValue(undefined),
  steerGrokTurn: vi.fn().mockResolvedValue(undefined),
  steerOpencodeTurn: vi.fn().mockResolvedValue(undefined),
  steerPiTurn: vi.fn().mockResolvedValue(undefined),
  steerClaudeTurn: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
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
    vi.mocked(steerGrokTurn).mockResolvedValue(undefined)
    vi.mocked(steerOpencodeTurn).mockResolvedValue(undefined)
    vi.mocked(steerPiTurn).mockResolvedValue(undefined)
    vi.mocked(steerClaudeTurn).mockResolvedValue(undefined)
    queryClient.removeQueries({ queryKey: preferencesQueryKeys.preferences() })
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
      editingQueuedMessageIds: {},
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      pendingSkills: {},
      pendingTextFiles: {},
    })
  })

  it('removes a queued message locally and persists removal', () => {
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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

  it('loads a queued message with its attachments into the composer', () => {
    const image = { id: 'img-1', path: '/tmp/a.png', filename: 'a.png' }
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1'),
          createMessage('msg-2', { pendingImages: [image] }),
        ],
      },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    act(() => result.current.handleEditQueuedMessage('session-1', 'msg-2'))

    const state = useChatStore.getState()
    expect(state.editingQueuedMessageIds['session-1']).toBe('msg-2')
    expect(state.inputDrafts['session-1']).toBe('prompt msg-2')
    expect(state.pendingImages['session-1']).toEqual([image])
  })

  it('does not overwrite an unsent composer draft', () => {
    useChatStore.setState({ inputDrafts: { 'session-1': 'my draft' } })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    act(() => result.current.handleEditQueuedMessage('session-1', 'msg-2'))

    const state = useChatStore.getState()
    expect(state.editingQueuedMessageIds['session-1']).toBeUndefined()
    expect(state.inputDrafts['session-1']).toBe('my draft')
  })

  it('cancelling an edit clears the composer and keeps the queued message', () => {
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    act(() => result.current.handleEditQueuedMessage('session-1', 'msg-2'))
    act(() => result.current.handleCancelQueuedEdit('session-1'))

    const state = useChatStore.getState()
    expect(state.editingQueuedMessageIds['session-1']).toBeUndefined()
    expect(state.inputDrafts['session-1']).toBeUndefined()
    expect(state.messageQueues['session-1']?.[1]?.message).toBe('prompt msg-2')
  })

  it('saves text and attachments in place and ends the edit', async () => {
    const textFile = {
      id: 'txt-1',
      path: '/tmp/t.txt',
      filename: 't.txt',
      size: 3,
      content: 'abc',
    }
    const edit = {
      message: 'updated prompt',
      pendingImages: [],
      pendingFiles: [],
      pendingSkills: [],
      pendingTextFiles: [textFile],
    }
    useChatStore.setState({ editingQueuedMessageIds: { 'session-1': 'msg-2' } })

    let saved = false
    await act(async () => {
      saved = await saveQueuedMessageEdit('session-1', 'msg-2', edit)
    })

    expect(saved).toBe(true)
    expect(persistUpdateQueued).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree-1',
      'session-1',
      'msg-2',
      edit
    )
    const state = useChatStore.getState()
    expect(state.messageQueues['session-1']?.map(m => m.message)).toEqual([
      'prompt msg-1',
      'updated prompt',
      'prompt msg-3',
    ])
    expect(state.messageQueues['session-1']?.[1]?.pendingTextFiles).toEqual([
      textFile,
    ])
    expect(state.editingQueuedMessageIds['session-1']).toBeUndefined()
  })

  it('keeps the edit in the composer when the message was already dequeued', async () => {
    vi.mocked(persistUpdateQueued).mockResolvedValue(false)
    useChatStore.setState({ editingQueuedMessageIds: { 'session-1': 'msg-2' } })

    let saved = true
    await act(async () => {
      saved = await saveQueuedMessageEdit('session-1', 'msg-2', {
        message: 'updated prompt',
        pendingImages: [],
        pendingFiles: [],
        pendingSkills: [],
        pendingTextFiles: [],
      })
    })

    expect(saved).toBe(false)
    const state = useChatStore.getState()
    expect(state.messageQueues['session-1']?.map(m => m.id)).toEqual([
      'msg-1',
      'msg-3',
    ])
    expect(state.editingQueuedMessageIds['session-1']).toBeUndefined()
  })

  it('ends the edit when the edited message leaves the queue', () => {
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))
    act(() => result.current.handleEditQueuedMessage('session-1', 'msg-1'))

    act(() => useChatStore.getState().removeQueuedMessage('session-1', 'msg-1'))

    const state = useChatStore.getState()
    expect(state.editingQueuedMessageIds['session-1']).toBeUndefined()
    // The composer keeps the edit so it can be sent as a new prompt
    expect(state.inputDrafts['session-1']).toBe('prompt msg-1')
  })

  it('idle session: promotes the message and force-processes the queue', async () => {
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerCodexTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      `prompt msg-1

[Image attached: /tmp/img.png - Use the Read tool to view this image]`,
      expect.objectContaining({ id: 'msg-1' })
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy pi session: steers the running turn and removes the message', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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

  it('busy grok session: steers the running turn and removes the message', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'grok' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(steerGrokTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'prompt msg-2'
    )
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-3'])
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy grok session: falls back to cancel+send when steering fails', async () => {
    vi.mocked(steerGrokTurn).mockRejectedValue(new Error('no active turn'))
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'grok' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(persistMoveQueuedFront).toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy pi session: falls back to cancel+send when steering fails', async () => {
    vi.mocked(steerPiTurn).mockRejectedValue(new Error('host unavailable'))
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(persistMoveQueuedFront).toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1', 'msg-3'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy opencode session with pasted text files: steers with path refs', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            message: 'check paste',
            pendingTextFiles: [
              { id: 'txt-1', path: '/tmp/input.txt' },
            ] as never,
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'opencode' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerOpencodeTurn).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree-1',
      'session-1',
      expect.stringContaining('[Text file attached: /tmp/input.txt')
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy pi session with file @-mentions: steers with file path refs', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            message: 'check @file.txt',
            pendingFiles: [
              {
                id: 'file-1',
                relativePath: 'file.txt',
                extension: 'txt',
                isDirectory: false,
              },
            ],
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerPiTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      expect.stringContaining('[File: file.txt')
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy pi session with pasted text files: steers with path refs', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            message: 'check paste',
            pendingTextFiles: [
              { id: 'txt-1', path: '/tmp/paste.txt' },
            ] as never,
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'pi' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerPiTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      expect.stringContaining('[Text file attached: /tmp/paste.txt')
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy grok session with images: steers with path refs', async () => {
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1', {
            message: 'check image',
            pendingImages: [
              { id: 'img-1', path: '/tmp/a.png', filename: 'a.png' },
            ] as never,
          }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'grok' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-1')
    })

    expect(steerGrokTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      expect.stringContaining('[Image attached: /tmp/a.png')
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy antigravity session: promotes to front and cancels instead of steering', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'antigravity' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(steerGrokTurn).not.toHaveBeenCalled()
    expect(steerOpencodeTurn).not.toHaveBeenCalled()
    expect(steerPiTurn).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-3', 'msg-1', 'msg-2'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy muse session: promotes to front and cancels instead of steering', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'muse' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(steerGrokTurn).not.toHaveBeenCalled()
    expect(steerOpencodeTurn).not.toHaveBeenCalled()
    expect(steerPiTurn).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-3', 'msg-1', 'msg-2'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy claude session with steering on: steers the running turn', async () => {
    queryClient.setQueryData(preferencesQueryKeys.preferences(), {
      claude_auto_steer_enabled: true,
    })
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerClaudeTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'prompt msg-3'
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-1', 'msg-2'])
  })

  it('busy remote claude session: uses the remote server steer setting', async () => {
    queryClient.setQueryData(preferencesQueryKeys.preferences(), {
      claude_auto_steer_enabled: false,
    })
    queryClient.setQueryData(preferencesQueryKeys.preferences('remote-1'), {
      claude_auto_steer_enabled: true,
    })
    useChatStore.setState({
      sessionWorktreeMap: { 'session-1': 'remote-1:worktree-1' },
      worktreePaths: { 'remote-1:worktree-1': '/tmp/worktree-1' },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerClaudeTurn).toHaveBeenCalledWith(
      'remote-1:worktree-1',
      'session-1',
      'prompt msg-3'
    )
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })

  it('busy claude session: steer failure falls back to promote + cancel', async () => {
    queryClient.setQueryData(preferencesQueryKeys.preferences(), {
      claude_auto_steer_enabled: true,
    })
    vi.mocked(steerClaudeTurn).mockRejectedValue(new Error('not steerable'))
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerClaudeTurn).toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-3', 'msg-1', 'msg-2'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy claude session: does not steer a prompt queued for another backend', async () => {
    queryClient.setQueryData(preferencesQueryKeys.preferences(), {
      claude_auto_steer_enabled: true,
    })
    useChatStore.setState({
      messageQueues: {
        'session-1': [
          createMessage('msg-1'),
          createMessage('msg-2', { backend: 'codex' }),
        ],
      },
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-2')
    })

    expect(steerClaudeTurn).not.toHaveBeenCalled()
    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1']?.map(m => m.id)
    ).toEqual(['msg-2', 'msg-1'])
    expect(cancelChatMessage).toHaveBeenCalledWith('session-1', 'worktree-1')
  })

  it('busy claude session: promotes to front and cancels the run', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      selectedBackends: { 'session-1': 'claude' },
    })
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'msg-3')
    })

    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(steerClaudeTurn).not.toHaveBeenCalled()
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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

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
    const { result } = renderHook(() => useQueuedPromptActions('session-1'))

    await act(async () => {
      await result.current.handleSendQueuedNow('session-1', 'unknown')
    })

    expect(persistMoveQueuedFront).not.toHaveBeenCalled()
    expect(cancelChatMessage).not.toHaveBeenCalled()
  })
})
