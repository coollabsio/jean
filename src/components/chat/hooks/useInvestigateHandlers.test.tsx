import React, { type RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { invoke } from '@/lib/transport'
import { defaultPreferences, type AppPreferences } from '@/types/preferences'
import type {
  EffortLevel,
  ExecutionMode,
  McpServerInfo,
  Session,
  ThinkingLevel,
} from '@/types/chat'
import { useInvestigateHandlers } from './useInvestigateHandlers'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

const ref = <T,>(current: T): RefObject<T> => ({ current })

function makeSession(id: string): Session {
  return {
    id,
    name: id,
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    backend: 'claude',
  }
}

function renderHandlers({
  executionMode = 'yolo',
  preferences,
}: {
  executionMode?: ExecutionMode
  preferences?: AppPreferences
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const sendMessage = { mutate: vi.fn() }
  const sessions = [
    makeSession('comment-session-1'),
    makeSession('comment-session-2'),
  ]
  const createSession = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(
      async () => sessions.shift() ?? makeSession('extra-session')
    ),
  }

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const hook = renderHook(
    () =>
      useInvestigateHandlers({
        activeSessionId: 'base-session',
        activeWorktreeId: 'worktree-1',
        activeWorktreePath: '/tmp/worktree',
        inputRef: ref({ focus: vi.fn() } as unknown as HTMLTextAreaElement),
        preferences: preferences ?? {
          ...defaultPreferences,
          magic_prompt_modes: {
            ...defaultPreferences.magic_prompt_modes,
            review_comments_mode:
              executionMode === 'build' ? 'plan' : executionMode,
          },
        },
        defaultBackend: 'claude',
        selectedModelRef: ref('claude-opus-4-8'),
        selectedThinkingLevelRef: ref('off' as ThinkingLevel),
        selectedEffortLevelRef: ref('high' as EffortLevel),
        executionModeRef: ref(executionMode),
        mcpServersDataRef: ref([] as McpServerInfo[]),
        enabledMcpServersRef: ref([]),
        activeWorktreeIdRef: ref('worktree-1'),
        activeWorktreePathRef: ref('/tmp/worktree'),
        sendMessage,
        setSessionProvider: { mutate: vi.fn() },
        setSessionBackend: { mutate: vi.fn() },
        setSessionModel: { mutate: vi.fn() },
        createSession,
        resolveCustomProfile: () => ({
          model: 'claude-opus-4-8',
          customProfileName: undefined,
        }),
        cliVersion: null,
        worktreeProjectId: 'project-1',
      }),
    { wrapper }
  )

  return { ...hook, sendMessage, createSession }
}

describe('useInvestigateHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined as never)
    useChatStore.setState({
      activeSessionIds: { 'worktree-1': 'base-session' },
      executionModes: { 'base-session': 'plan' },
      selectedBackends: {},
      selectedModels: {},
      selectedProviders: {},
      sendingSessionIds: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
    })
  })

  it('uses the dedicated Sentry prompt and execution settings', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'get_sentry_issue_context_contents') {
        return [
          {
            id: '123',
            shortId: 'COOLIFY-BXB',
            title: 'Connection timeout',
            permalink: 'https://sentry.io/issues/123',
            content: '# Sentry context\n\nStack trace',
          },
        ] as never
      }
      return undefined as never
    })
    const preferences: AppPreferences = {
      ...defaultPreferences,
      magic_prompts: {
        ...defaultPreferences.magic_prompts,
        investigate_sentry_issue:
          'Investigate {sentryWord} {sentryRefs}\n\n{sentryContext}',
      },
      magic_prompt_models: {
        ...defaultPreferences.magic_prompt_models,
        investigate_sentry_issue_model: 'gpt-5.5',
      },
      magic_prompt_backends: {
        ...defaultPreferences.magic_prompt_backends,
        investigate_sentry_issue_backend: 'codex',
      },
      magic_prompt_modes: {
        ...defaultPreferences.magic_prompt_modes,
        investigate_sentry_issue_mode: 'yolo',
      },
    }
    const { result, sendMessage } = renderHandlers({ preferences })

    await act(async () => {
      await result.current.handleInvestigate('sentry-issue')
    })

    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'Investigate issue COOLIFY-BXB\n\n# Sentry context\n\nStack trace'
        ),
        model: 'gpt-5.5',
        backend: 'codex',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    const sent = vi.mocked(sendMessage.mutate).mock.calls[0]?.[0] as {
      message: string
    }
    expect(sent.message).toContain('<yolo_investigation_fix>')
    expect(sent.message).toContain('After investigation, fix the issue')
  })

  it('uses magic prompt effort for Grok workflow run investigation', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'list_projects') {
        return [
          {
            id: 'project-1',
            name: 'demo',
            path: '/tmp/demo',
          },
        ] as never
      }
      if (command === 'list_worktrees') {
        return [
          {
            id: 'worktree-1',
            path: '/tmp/worktree',
            branch: 'main',
            status: 'ready',
            project_id: 'project-1',
          },
        ] as never
      }
      return undefined as never
    })

    const preferences: AppPreferences = {
      ...defaultPreferences,
      magic_prompt_models: {
        ...defaultPreferences.magic_prompt_models,
        investigate_workflow_run_model: 'grok/grok-4.5',
      },
      magic_prompt_backends: {
        ...defaultPreferences.magic_prompt_backends,
        investigate_workflow_run_backend: 'grok',
      },
      magic_prompt_modes: {
        ...defaultPreferences.magic_prompt_modes,
        investigate_workflow_run_mode: 'yolo',
      },
      magic_prompt_efforts: {
        ...defaultPreferences.magic_prompt_efforts,
        investigate_workflow_run_effort: 'medium',
      },
    }

    const sendMessage = { mutate: vi.fn() }
    const createSession = {
      mutate: vi.fn(
        (
          _args: { worktreeId: string; worktreePath: string },
          opts?: {
            onSuccess?: (session: { id: string }) => void
            onError?: (error: unknown) => void
          }
        ) => {
          opts?.onSuccess?.({ id: 'wf-session-1' })
        }
      ),
      mutateAsync: vi.fn(async () => makeSession('wf-session-1')),
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(
      () =>
        useInvestigateHandlers({
          activeSessionId: 'base-session',
          activeWorktreeId: 'worktree-1',
          activeWorktreePath: '/tmp/worktree',
          inputRef: ref({ focus: vi.fn() } as unknown as HTMLTextAreaElement),
          preferences,
          defaultBackend: 'grok',
          selectedModelRef: ref('grok/grok-4.5'),
          selectedThinkingLevelRef: ref('think' as ThinkingLevel),
          selectedEffortLevelRef: ref('high' as EffortLevel),
          executionModeRef: ref('yolo' as ExecutionMode),
          mcpServersDataRef: ref([] as McpServerInfo[]),
          enabledMcpServersRef: ref([]),
          activeWorktreeIdRef: ref('worktree-1'),
          activeWorktreePathRef: ref('/tmp/worktree'),
          sendMessage,
          setSessionProvider: { mutate: vi.fn() },
          setSessionBackend: { mutate: vi.fn() },
          setSessionModel: { mutate: vi.fn() },
          createSession,
          resolveCustomProfile: () => ({
            model: 'grok/grok-4.5',
            customProfileName: undefined,
          }),
          cliVersion: null,
          worktreeProjectId: 'project-1',
        }),
      { wrapper }
    )

    await act(async () => {
      await result.current.handleInvestigateWorkflowRun({
        workflowName: 'CI',
        runUrl: 'https://github.com/org/repo/actions/runs/123',
        runId: '123',
        branch: 'main',
        displayTitle: 'CI failed',
        projectPath: '/tmp/demo',
      })
    })

    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'grok/grok-4.5',
        backend: 'grok',
        executionMode: 'yolo',
        effortLevel: 'medium',
        thinkingLevel: undefined,
      }),
      expect.any(Object)
    )
    expect(useChatStore.getState().effortLevels['wf-session-1']).toBe('medium')
  })

  it('keeps the session UI execution mode in sync with separate review comment send mode', async () => {
    const { result, sendMessage } = renderHandlers({ executionMode: 'yolo' })

    await act(async () => {
      await result.current.handleReviewComments(['fix one', 'fix two'])
    })

    expect(sendMessage.mutate).toHaveBeenCalledTimes(2)
    expect(sendMessage.mutate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'comment-session-1',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    expect(sendMessage.mutate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'comment-session-2',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    expect(useChatStore.getState().executionModes['comment-session-1']).toBe(
      'yolo'
    )
    expect(useChatStore.getState().executionModes['comment-session-2']).toBe(
      'yolo'
    )
  })

  it('uses an explicit yolo override even when current session mode is plan', async () => {
    const { result, sendMessage } = renderHandlers({ executionMode: 'plan' })

    await act(async () => {
      await result.current.handleReviewComments(['fix one'], {
        executionMode: 'yolo',
      })
    })

    expect(sendMessage.mutate).toHaveBeenCalledTimes(1)
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'comment-session-1',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    expect(useChatStore.getState().executionModes['comment-session-1']).toBe(
      'yolo'
    )
  })
})
