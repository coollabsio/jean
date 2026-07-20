import { act, renderHook } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useMessageSending } from './useMessageSending'
import {
  persistEnqueue,
  steerCodexTurn,
  steerGrokTurn,
  steerOpencodeTurn,
  steerPiTurn,
} from '@/services/chat'
import type { ExecutionMode, Session } from '@/types/chat'
import type * as ChatService from '@/services/chat'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
  },
}))

vi.mock('@/services/chat', async importOriginal => {
  const actual = await importOriginal<typeof ChatService>()
  return {
    ...actual,
    cancelChatMessage: vi.fn(),
    persistEnqueue: vi.fn(),
    steerCodexTurn: vi.fn(),
    steerGrokTurn: vi.fn(),
    steerOpencodeTurn: vi.fn(),
    steerPiTurn: vi.fn(),
  }
})

function renderUseMessageSending({
  goalMode,
  autoSteer,
  opencodeAutoSteer,
  piAutoSteer,
  grokAutoSteer,
  inputValue = '/goal Ship the feature',
  selectedBackend = 'codex',
  selectedModel = 'gpt-5.5',
  selectedEffortLevel = 'high',
  createSession = {
    mutateAsync: vi.fn(async () => ({
      id: 'new-session',
      name: 'New Session',
      order: 2,
      created_at: Date.now(),
      updated_at: Date.now(),
      messages: [],
    })) as (args: {
      worktreeId: string
      worktreePath: string
    }) => Promise<Session>,
  },
}: {
  goalMode?: 'build' | 'yolo'
  autoSteer?: boolean
  opencodeAutoSteer?: boolean
  piAutoSteer?: boolean
  grokAutoSteer?: boolean
  inputValue?: string
  selectedBackend?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'pi' | 'grok'
  selectedModel?: string
  selectedEffortLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  createSession?: {
    mutateAsync: (args: {
      worktreeId: string
      worktreePath: string
    }) => Promise<Session>
  }
} = {}) {
  const sendMessage = { mutate: vi.fn() }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const inputRef = {
    current: { value: inputValue } as HTMLTextAreaElement,
  }
  const executionModeRef = { current: 'plan' as ExecutionMode }

  const hook = renderHook(() =>
    useMessageSending({
      activeSessionId: 'session-1',
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/tmp/worktree',
      inputRef,
      selectedModelRef: { current: selectedModel },
      selectedProviderRef: { current: null },
      selectedThinkingLevelRef: { current: 'off' },
      selectedEffortLevelRef: { current: selectedEffortLevel },
      executionModeRef,
      useAdaptiveThinkingRef: { current: false },
      isCodexBackendRef: { current: selectedBackend === 'codex' },
      mcpServersDataRef: { current: [] },
      enabledMcpServersRef: { current: [] },
      selectedBackendRef: { current: selectedBackend },
      preferences: {
        codex_goal_execution_mode: goalMode,
        codex_auto_steer_enabled: autoSteer,
        opencode_auto_steer_enabled: opencodeAutoSteer,
        pi_auto_steer_enabled: piAutoSteer,
        grok_auto_steer_enabled: grokAutoSteer,
      },
      sendMessage,
      createSession,
      queryClient,
      markAtBottom: vi.fn(),
      sessionsData: { sessions: [{ id: 'session-1' }] },
      clearInputDraft: vi.fn(),
      clearChatInputState: vi.fn(),
    })
  )

  return { ...hook, sendMessage, executionModeRef, createSession }
}

describe('useMessageSending Codex /goal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.setState({
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      pendingSkills: {},
      sendingSessionIds: {},
      executionModes: {},
      selectedModels: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      messageQueues: {},
      approvedTools: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
    })
  })

  it('starts goals in build mode by default', async () => {
    const { result, sendMessage, executionModeRef } = renderUseMessageSending()

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(mockInvoke).toHaveBeenCalledWith('codex_goal_set', {
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
      sessionId: 'session-1',
      objective: 'Ship the feature',
    })
    expect(useChatStore.getState().executionModes['session-1']).toBe('build')
    expect(executionModeRef.current).toBe('build')
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'build',
        message: 'Work toward the active goal:\n\nShip the feature',
        backend: 'codex',
      }),
      expect.any(Object)
    )
  })

  it('starts goals in yolo mode when configured', async () => {
    const { result, sendMessage, executionModeRef } = renderUseMessageSending({
      goalMode: 'yolo',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(useChatStore.getState().executionModes['session-1']).toBe('yolo')
    expect(executionModeRef.current).toBe('yolo')
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'yolo',
        message: 'Work toward the active goal:\n\nShip the feature',
      }),
      expect.any(Object)
    )
  })
})

describe('useMessageSending Grok /goal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.setState({
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      pendingSkills: {},
      sendingSessionIds: {},
      executionModes: {},
      selectedModels: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      messageQueues: {},
      approvedTools: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
    })
  })

  it('passes /goal commands through to Grok without Codex RPC wrapping', async () => {
    const { result, sendMessage, executionModeRef } = renderUseMessageSending({
      selectedBackend: 'grok',
      selectedModel: 'grok/grok-4.5',
      inputValue: '/goal Ship the Grok feature',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'codex_goal_set',
      expect.anything()
    )
    expect(executionModeRef.current).toBe('plan')
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'grok',
        executionMode: 'plan',
        message: '/goal Ship the Grok feature',
      }),
      expect.any(Object)
    )
  })
})

describe('useMessageSending PI effort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.setState({
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      pendingSkills: {},
      sendingSessionIds: {},
      executionModes: {},
      selectedModels: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      messageQueues: {},
      approvedTools: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
    })
  })

  it('passes selected PI effort when sending a PI prompt', async () => {
    const { result, sendMessage } = renderUseMessageSending({
      selectedBackend: 'pi',
      selectedModel: 'pi/openai-codex/gpt-5.5',
      selectedEffortLevel: 'xhigh',
      inputValue: 'inspect pi effort',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'pi',
        effortLevel: 'xhigh',
        thinkingLevel: 'off',
      }),
      expect.any(Object)
    )
  })
})

describe('useMessageSending git diff Add to prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.setState({
      activeSessionIds: { 'worktree-1': 'session-1' },
      inputDrafts: { 'session-1': 'existing draft' },
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      pendingSkills: {},
      sendingSessionIds: { 'session-1': true },
      executionModes: { 'session-1': 'yolo' },
      selectedModels: { 'session-1': 'gpt-5.5' },
      executingModes: {},
      errors: {},
      lastSentMessages: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      messageQueues: {},
      approvedTools: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
    })
  })

  it('creates a new current-worktree session and drafts diff comments without sending', async () => {
    const { result, sendMessage, createSession } = renderUseMessageSending()

    await act(async () => {
      await result.current.handleGitDiffAddToPrompt('review this selected line')
    })

    expect(vi.mocked(createSession.mutateAsync)).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
    })
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'new-session'
    )
    expect(useChatStore.getState().inputDrafts['new-session']).toBe(
      'existing draft\nreview this selected line'
    )
    expect(useChatStore.getState().executionModes['new-session']).toBe('yolo')
    expect(sendMessage.mutate).not.toHaveBeenCalled()
  })
})

describe('useMessageSending Codex auto-steer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.setState({
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      pendingSkills: {},
      sendingSessionIds: { 'session-1': true },
      executionModes: {},
      selectedModels: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      messageQueues: {},
      approvedTools: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
    })
  })

  it('steers the running codex turn instead of queueing by default', async () => {
    vi.mocked(steerCodexTurn).mockResolvedValue(undefined)
    const { result, sendMessage } = renderUseMessageSending({
      inputValue: 'also check the tests',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerCodexTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'also check the tests'
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1'] ?? []
    ).toHaveLength(0)
    expect(sendMessage.mutate).not.toHaveBeenCalled()
  })

  it('steers the running pi turn instead of queueing when auto-steer is enabled', async () => {
    vi.mocked(steerPiTurn).mockResolvedValue(undefined)
    const { result, sendMessage } = renderUseMessageSending({
      selectedBackend: 'pi',
      selectedModel: 'pi/openai-codex/gpt-5.5',
      inputValue: 'also inspect pi',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerPiTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'also inspect pi'
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1'] ?? []
    ).toHaveLength(0)
    expect(sendMessage.mutate).not.toHaveBeenCalled()
  })

  it('steers the running grok turn instead of queueing when auto-steer is enabled', async () => {
    vi.mocked(steerGrokTurn).mockResolvedValue(undefined)
    const { result, sendMessage } = renderUseMessageSending({
      selectedBackend: 'grok',
      selectedModel: 'grok/grok-4.5',
      inputValue: 'also inspect grok',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerGrokTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      'also inspect grok'
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1'] ?? []
    ).toHaveLength(0)
    expect(sendMessage.mutate).not.toHaveBeenCalled()
  })

  it('steers the running opencode turn instead of queueing by default', async () => {
    vi.mocked(steerOpencodeTurn).mockResolvedValue(undefined)
    const { result, sendMessage } = renderUseMessageSending({
      selectedBackend: 'opencode',
      selectedModel: 'opencode/gpt-5.5',
      inputValue: 'also inspect opencode',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerOpencodeTurn).toHaveBeenCalledWith(
      'worktree-1',
      '/tmp/worktree',
      'session-1',
      'also inspect opencode'
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1'] ?? []
    ).toHaveLength(0)
    expect(sendMessage.mutate).not.toHaveBeenCalled()
  })

  it('steers codex attachments instead of queueing when auto-steer is enabled', async () => {
    vi.mocked(steerCodexTurn).mockResolvedValue(undefined)
    const { result } = renderUseMessageSending({
      inputValue: 'please inspect',
    })
    useChatStore.setState({
      pendingImages: {
        'session-1': [
          { id: 'img-1', path: '/tmp/img.png', filename: 'img.png' },
        ],
      },
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerCodexTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      `please inspect

[Image attached: /tmp/img.png - Use the Read tool to view this image]`,
      expect.objectContaining({
        pendingImages: [
          expect.objectContaining({ path: '/tmp/img.png' }),
        ],
      })
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
  })

  it('queues instead of steering when auto-steer is disabled', async () => {
    const { result } = renderUseMessageSending({
      autoSteer: false,
      inputValue: 'also check the tests',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerCodexTurn).not.toHaveBeenCalled()
    expect(persistEnqueue).toHaveBeenCalled()
    expect(useChatStore.getState().messageQueues['session-1']).toHaveLength(1)
  })

  it('queues pi prompts instead of steering when pi auto-steer is disabled', async () => {
    const { result } = renderUseMessageSending({
      selectedBackend: 'pi',
      selectedModel: 'pi/openai-codex/gpt-5.5',
      piAutoSteer: false,
      inputValue: 'also inspect pi',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerPiTurn).not.toHaveBeenCalled()
    expect(persistEnqueue).toHaveBeenCalled()
    expect(useChatStore.getState().messageQueues['session-1']).toHaveLength(1)
  })

  it('queues grok prompts instead of steering when grok auto-steer is disabled', async () => {
    const { result } = renderUseMessageSending({
      selectedBackend: 'grok',
      selectedModel: 'grok/grok-4.5',
      grokAutoSteer: false,
      inputValue: 'also inspect grok',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerGrokTurn).not.toHaveBeenCalled()
    expect(persistEnqueue).toHaveBeenCalled()
    expect(useChatStore.getState().messageQueues['session-1']).toHaveLength(1)
  })

  it('steers grok prompts with pasted images as path refs', async () => {
    vi.mocked(steerGrokTurn).mockResolvedValue(undefined)
    const { result } = renderUseMessageSending({
      selectedBackend: 'grok',
      selectedModel: 'grok/grok-4.5',
      inputValue: 'also inspect grok',
    })
    useChatStore.setState({
      pendingImages: {
        'session-1': [
          { id: 'img-1', path: '/tmp/img.png', filename: 'img.png' },
        ],
      },
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerGrokTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      expect.stringContaining(
        '[Image attached: /tmp/img.png - Use the Read tool to view this image]'
      )
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
  })

  it('steers grok prompts with pasted text files as path refs', async () => {
    vi.mocked(steerGrokTurn).mockResolvedValue(undefined)
    const { result } = renderUseMessageSending({
      selectedBackend: 'grok',
      selectedModel: 'grok/grok-4.5',
      inputValue: 'check this paste',
    })
    useChatStore.setState({
      pendingTextFiles: {
        'session-1': [
          {
            id: 'txt-1',
            path: '/tmp/pasted-texts/paste-1.txt',
            filename: 'paste-1.txt',
            content: 'hello',
            size: 5,
          },
        ],
      },
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerGrokTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      expect.stringContaining(
        '[Text file attached: /tmp/pasted-texts/paste-1.txt - Use the Read tool to view this file]'
      )
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
  })

  it('steers grok prompts with file @-mentions instead of queueing', async () => {
    vi.mocked(steerGrokTurn).mockResolvedValue(undefined)
    const { result } = renderUseMessageSending({
      selectedBackend: 'grok',
      selectedModel: 'grok/grok-4.5',
      inputValue:
        'i dont think we need to change the @AppServiceProvider.php as it worked before without it',
    })
    useChatStore.setState({
      pendingFiles: {
        'session-1': [
          {
            id: 'file-1',
            relativePath: 'app/Providers/AppServiceProvider.php',
            extension: 'php',
            isDirectory: false,
          },
        ],
      },
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerGrokTurn).toHaveBeenCalledWith(
      'worktree-1',
      'session-1',
      expect.stringContaining(
        '[File: app/Providers/AppServiceProvider.php - Use the Read tool to view this file]'
      )
    )
    expect(persistEnqueue).not.toHaveBeenCalled()
    expect(
      useChatStore.getState().messageQueues['session-1'] ?? []
    ).toHaveLength(0)
  })

  it('queues opencode prompts instead of steering when opencode auto-steer is disabled', async () => {
    const { result } = renderUseMessageSending({
      selectedBackend: 'opencode',
      selectedModel: 'opencode/gpt-5.5',
      opencodeAutoSteer: false,
      inputValue: 'also inspect opencode',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerOpencodeTurn).not.toHaveBeenCalled()
    expect(persistEnqueue).toHaveBeenCalled()
    expect(useChatStore.getState().messageQueues['session-1']).toHaveLength(1)
  })

  it('falls back to queueing when steering fails', async () => {
    vi.mocked(steerCodexTurn).mockRejectedValue(new Error('turn ended'))
    const { result } = renderUseMessageSending({
      inputValue: 'also check the tests',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(steerCodexTurn).toHaveBeenCalled()
    expect(persistEnqueue).toHaveBeenCalled()
    expect(useChatStore.getState().messageQueues['session-1']).toHaveLength(1)
  })
})
