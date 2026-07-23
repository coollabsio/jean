import React, { type RefObject } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useGitOperations } from './useGitOperations'
import type {
  EffortLevel,
  ExecutionMode,
  McpServerInfo,
  Session,
  ThinkingLevel,
} from '@/types/chat'
import type { Project, Worktree } from '@/types/projects'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  toastLoading: vi.fn(() => 'toast-1'),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mocks.invoke,
  listen: mocks.listen,
}))
vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    info: mocks.toastInfo,
    warning: mocks.toastWarning,
    error: mocks.toastError,
    success: mocks.toastSuccess,
    dismiss: mocks.toastDismiss,
  },
}))
vi.mock('@/services/git-status', () => ({
  gitPush: vi.fn(),
  triggerImmediateGitPoll: vi.fn(),
  triggerImmediateRemotePoll: vi.fn(),
  fetchWorktreesStatus: vi.fn(),
  performGitPull: vi.fn(),
}))
vi.mock('@/lib/platform', () => ({
  openExternal: vi.fn(),
  isMacOS: false,
  isWindows: false,
  isLinux: true,
  getServerPlatform: vi.fn(() => 'linux'),
  isServerWindows: vi.fn(() => false),
}))

const ref = <T,>(current: T): RefObject<T> => ({ current })

const worktree: Worktree = {
  id: 'wt-1',
  project_id: 'project-1',
  name: 'feature',
  path: '/repo/worktree',
  branch: 'feature',
  pr_number: 31,
  pr_url: 'https://github.com/o/r/pull/31',
  created_at: 1,
  order: 0,
}

const project: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/repo',
  default_branch: 'main',
  added_at: 1,
  order: 0,
}

function renderGitOperations(preferenceOverrides = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const sendMessage = { mutate: vi.fn() }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const hook = renderHook(
    () =>
      useGitOperations({
        activeWorktreeId: 'wt-1',
        activeSessionId: 'session-current',
        activeWorktreePath: '/repo/worktree',
        worktree,
        project,
        queryClient,
        inputRef: ref({ focus: vi.fn() } as unknown as HTMLTextAreaElement),
        preferences: {
          default_backend: 'claude',
          selected_model: 'sonnet',
          selected_codex_model: 'gpt-5.5',
          magic_prompts: { resolve_conflicts: 'Resolve and finish.' },
          magic_prompt_backends: { resolve_conflicts_backend: 'codex' },
          ...preferenceOverrides,
        } as never,
        setSessionModel: { mutate: vi.fn() },
        setSessionBackend: { mutate: vi.fn() },
        setSessionProvider: { mutate: vi.fn() },
        sendMessage,
        selectedThinkingLevelRef: ref('off' as ThinkingLevel),
        selectedEffortLevelRef: ref('medium' as EffortLevel),
        mcpServersDataRef: ref([] as McpServerInfo[]),
        enabledMcpServersRef: ref([]),
      }),
    { wrapper }
  )

  return { ...hook, sendMessage, queryClient }
}

describe('useGitOperations conflict resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      activeSessionIds: { 'wt-1': 'session-current' },
      inputDrafts: {},
      executionModes: { 'session-current': 'plan' as ExecutionMode },
      selectedBackends: {},
      selectedModels: {},
      selectedProviders: {},
      sendingSessionIds: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
    })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch',
        })
      }
      if (command === 'create_session') {
        const session: Session = {
          id: 'conflict-session',
          name: 'Resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        }
        return Promise.resolve(session)
      }
      return Promise.resolve(undefined)
    })
    mocks.listen.mockResolvedValue(vi.fn())
  })

  it('sends detected conflicts immediately in yolo mode instead of drafting them', async () => {
    const { result, sendMessage } = renderGitOperations()

    await act(async () => {
      await result.current.handleResolveConflicts()
    })

    expect(
      useChatStore.getState().inputDrafts['conflict-session']
    ).toBeUndefined()
    expect(useChatStore.getState().executionModes['conflict-session']).toBe(
      'yolo'
    )
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conflict-session',
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        model: 'gpt-5.5',
        executionMode: 'yolo',
        effortLevel: 'medium',
        backend: 'codex',
      }),
      expect.any(Object)
    )
    const sentArgs = sendMessage.mutate.mock.calls[0]?.[0]
    expect(sentArgs?.message).toContain(
      'I have merge conflicts that need to be resolved.'
    )
    expect(sentArgs?.message).toContain('Resolve and finish.')
  })

  it('starts a dedicated Final review session with the configured audit prompt', async () => {
    const { result, sendMessage } = renderGitOperations({
      magic_prompts: {
        final_review: 'Audit this change and return tables only.',
      },
      magic_prompt_backends: { final_review_backend: 'codex' },
      magic_prompt_models: { final_review_model: 'gpt-5.5' },
      magic_prompt_efforts: { final_review_effort: 'high' },
      magic_prompt_modes: { final_review_mode: 'plan' },
    })

    await act(async () => {
      await result.current.handleFinalReview()
    })

    expect(mocks.invoke).toHaveBeenCalledWith(
      'create_session',
      expect.objectContaining({
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        name: 'Final review',
        backend: 'codex',
      })
    )
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conflict-session',
        message: 'Audit this change and return tables only.',
        model: 'gpt-5.5',
        effortLevel: 'high',
        executionMode: 'plan',
        backend: 'codex',
      }),
      expect.any(Object)
    )
    expect(mocks.invoke).toHaveBeenCalledWith('update_session_state', {
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      sessionId: 'conflict-session',
      selectedExecutionMode: 'plan',
    })
  })

  it('shows a cancel button while creating a PR and cancels the backend action', async () => {
    let resolveCreatePr: ((value: unknown) => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'create_pr_with_ai_content') {
        return new Promise(resolve => {
          resolveCreatePr = resolve
        })
      }
      if (command === 'cancel_create_pr_with_ai_content') {
        return Promise.resolve(true)
      }
      return Promise.resolve(undefined)
    })

    const { result } = renderGitOperations()

    await act(async () => {
      void result.current.handleOpenPr()
    })

    const loadingOptions = (
      mocks.toastLoading.mock.calls as unknown as [
        string,
        {
          cancel: { label: string; onClick: () => Promise<void> }
        },
      ][]
    )[0]?.[1]
    expect(loadingOptions).toBeDefined()
    expect(loadingOptions).toEqual(
      expect.objectContaining({
        cancel: expect.objectContaining({
          label: 'Cancel',
          onClick: expect.any(Function),
        }),
      })
    )

    if (!loadingOptions) {
      throw new Error('Expected loading toast options')
    }

    await act(async () => {
      await loadingOptions.cancel.onClick()
    })

    expect(mocks.invoke).toHaveBeenCalledWith(
      'cancel_create_pr_with_ai_content',
      { worktreePath: '/repo/worktree' }
    )
    expect(mocks.toastInfo).toHaveBeenCalledWith('Cancelling PR creation...', {
      id: 'toast-1',
    })

    if (!resolveCreatePr) {
      throw new Error('Expected create_pr_with_ai_content to be invoked')
    }
    const completeCreatePr = resolveCreatePr

    await act(async () => {
      completeCreatePr({
        pr_number: 32,
        pr_url: 'https://github.com/o/r/pull/32',
        title: 'Feature',
        existing: false,
      })
    })
  })

  it('starts magic commit as a backend-owned job', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            id: 'commit-job-1',
            worktreePath: '/repo/worktree',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_commit_job') {
        return Promise.resolve({
          id: 'commit-job-1',
          worktreePath: '/repo/worktree',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        })
      }
      return Promise.resolve(undefined)
    })

    const { result } = renderGitOperations()

    await act(async () => {
      await result.current.handleCommit()
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commit-jobs',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
      })
    )
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'create_commit_with_ai',
      expect.anything()
    )
    fetchMock.mockRestore()
  })

  it('uses the PR conflict flow when no local conflicts exist yet', async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: false,
          conflicts: [],
          conflict_diff: '',
        })
      }
      if (command === 'fetch_and_merge_base') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/pr-file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main',
        })
      }
      if (command === 'create_session') {
        const session: Session = {
          id: 'pr-conflict-session',
          name: 'PR: resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        }
        return Promise.resolve(session)
      }
      return Promise.resolve(undefined)
    })

    const { result, sendMessage } = renderGitOperations()

    await act(async () => {
      await result.current.handleResolveConflicts()
    })

    expect(mocks.invoke).toHaveBeenCalledWith('fetch_and_merge_base', {
      worktreeId: 'wt-1',
    })
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'pr-conflict-session',
        executionMode: 'yolo',
        backend: 'codex',
      }),
      expect.any(Object)
    )
    const sentArgs = sendMessage.mutate.mock.calls[0]?.[0]
    expect(sentArgs?.message).toContain(
      'I merged `origin/main` into this branch to resolve PR conflicts'
    )
  })

  it('reconciles a review job that finished before the listener is active', async () => {
    const reviewSession: Session = {
      id: 'review-session',
      name: 'Code Review',
      order: 1,
      created_at: 1,
      updated_at: 2,
      messages: [],
      backend: 'claude',
      is_reviewing: false,
      last_run_status: 'completed',
      review_results: {
        summary: 'Two findings.',
        approval_status: 'changes_requested',
        findings: [],
      },
    }
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'start_review_job') {
        return Promise.resolve({
          job: {
            id: 'job-1',
            reviewRunId: 'run-1',
            worktreeId: 'wt-1',
            worktreePath: '/repo/worktree',
            sessionId: 'review-session',
            source: 'ai',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        })
      }
      if (command === 'get_review_job') {
        return Promise.resolve({
          id: 'job-1',
          reviewRunId: 'run-1',
          worktreeId: 'wt-1',
          worktreePath: '/repo/worktree',
          sessionId: 'review-session',
          source: 'ai',
          status: 'completed',
          findingCount: 2,
          createdAt: 1,
          updatedAt: 2,
        })
      }
      if (command === 'get_sessions') {
        return Promise.resolve({
          worktree_id: 'wt-1',
          active_session_id: 'review-session',
          version: 2,
          sessions: [reviewSession],
        })
      }
      return Promise.resolve(undefined)
    })

    const { result, queryClient } = renderGitOperations()
    queryClient.setQueryData(['all-sessions'], {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Project',
          worktree_id: 'wt-1',
          worktree_name: 'feature',
          worktree_path: '/repo/worktree',
          sessions: [],
        },
      ],
    })

    await act(async () => {
      await result.current.handleReview()
    })

    expect(mocks.listen).toHaveBeenCalledWith(
      'review-job:updated',
      expect.any(Function)
    )
    expect(mocks.invoke).toHaveBeenCalledWith('get_review_job', {
      jobId: 'job-1',
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Review done on Project/feature (2 findings)',
      expect.objectContaining({
        action: expect.objectContaining({ onClick: expect.any(Function) }),
      })
    )
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
    expect(mocks.toastSuccess.mock.calls[0]?.[1]).not.toHaveProperty('cancel')
    await waitFor(() => {
      expect(queryClient.getQueryData(['all-sessions'])).toMatchObject({
        entries: [
          {
            worktree_id: 'wt-1',
            sessions: [
              {
                id: 'review-session',
                last_run_status: 'completed',
                review_results: {
                  summary: 'Two findings.',
                },
              },
            ],
          },
        ],
      })
    })
    expect(mocks.invoke).toHaveBeenCalledWith('get_sessions', {
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
    })
    expect(mocks.toastLoading).toHaveBeenLastCalledWith(
      'Review running for Project/feature...',
      expect.objectContaining({
        cancel: expect.objectContaining({ label: 'Cancel' }),
      })
    )
  })

  it('auto-dismisses the running review toast after 5 seconds', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'start_review_job') {
        return Promise.resolve({
          job: {
            id: 'job-1',
            reviewRunId: 'run-1',
            worktreeId: 'wt-1',
            worktreePath: '/repo/worktree',
            sessionId: 'review-session',
            source: 'ai',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        })
      }
      if (command === 'get_review_job') {
        return Promise.resolve({
          id: 'job-1',
          reviewRunId: 'run-1',
          worktreeId: 'wt-1',
          worktreePath: '/repo/worktree',
          sessionId: 'review-session',
          source: 'ai',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        })
      }
      return Promise.resolve(undefined)
    })

    const { result } = renderGitOperations()

    await act(async () => {
      await result.current.handleReview()
    })

    expect(mocks.toastDismiss).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
    vi.useRealTimers()
  })

  it('passes the code review magic prompt backend to review jobs', async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'start_review_job') {
        return Promise.resolve({
          job: {
            id: 'job-1',
            reviewRunId: 'run-1',
            worktreeId: 'wt-1',
            worktreePath: '/repo/worktree',
            sessionId: 'review-session',
            source: 'ai',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        })
      }
      if (command === 'get_review_job') {
        return Promise.resolve({
          id: 'job-1',
          reviewRunId: 'run-1',
          worktreeId: 'wt-1',
          worktreePath: '/repo/worktree',
          sessionId: 'review-session',
          source: 'ai',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        })
      }
      return Promise.resolve(undefined)
    })

    const { result } = renderGitOperations()

    await act(async () => {
      await result.current.handleReview()
    })

    expect(mocks.invoke).toHaveBeenCalledWith(
      'start_review_job',
      expect.objectContaining({
        backend: 'claude',
      })
    )
  })

  it('starts one review job for each configured backend and model', async () => {
    let jobIndex = 0
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'start_review_job') {
        jobIndex += 1
        return Promise.resolve({
          job: {
            id: `job-${jobIndex}`,
            reviewRunId: `run-${jobIndex}`,
            worktreeId: 'wt-1',
            worktreePath: '/repo/worktree',
            sessionId: `review-session-${jobIndex}`,
            source: 'ai',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        })
      }
      if (command === 'get_review_job') return Promise.resolve(null)
      return Promise.resolve(undefined)
    })

    const { result } = renderGitOperations({
      magic_code_review_configs: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'low',
        },
        {
          backend: 'claude',
          model: 'claude-opus-4-8[1m]',
          reasoning_effort: 'high',
        },
      ],
    })

    await act(async () => {
      await result.current.handleReview()
    })

    expect(mocks.invoke).toHaveBeenCalledWith(
      'start_review_job',
      expect.objectContaining({
        backend: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'low',
      })
    )
    expect(mocks.invoke).toHaveBeenCalledWith(
      'start_review_job',
      expect.objectContaining({
        backend: 'claude',
        model: 'claude-opus-4-8[1m]',
        reasoningEffort: 'high',
        sessionId: 'review-session-1',
      })
    )
  })
})
