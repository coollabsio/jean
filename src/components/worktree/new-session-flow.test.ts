import { describe, expect, it, vi } from 'vitest'
import type { QueuedMessage, Session } from '@/types/chat'
import type { Worktree } from '@/types/projects'
import {
  finishNewSessionFlow,
  prepareWorktreeCreationTracker,
  resolveWorktreeCreateArgs,
  startNewSessionPrompt,
} from './new-session-flow'

const worktree = {
  id: 'wt-1',
  path: '/tmp/project/wt-1',
  name: 'wt-1',
} as Worktree
const session = { id: 'session-1' } as Session
const queuedMessage: QueuedMessage = {
  id: 'queued-1',
  message: 'Implement the feature',
  pendingImages: [],
  pendingFiles: [],
  pendingSkills: [],
  pendingTextFiles: [],
  model: 'claude-sonnet-4-6',
  provider: null,
  executionMode: 'yolo',
  thinkingLevel: 'off',
  backend: 'claude',
  queuedAt: 1,
}

describe('resolveWorktreeCreateArgs', () => {
  it('uses a selected branch as the actual base and does not fetch context', async () => {
    const invoke = vi.fn()
    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      source: { type: 'branch', branch: 'feature/existing' },
      baseBranch: 'main',
      customName: 'my-worktree',
    })

    expect(result).toEqual({
      projectId: 'project-1',
      baseBranch: 'feature/existing',
      customName: 'my-worktree',
      background: true,
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('fetches complete PR context and lets the PR own its branch', async () => {
    const invoke = vi.fn().mockResolvedValue({
      number: 42,
      title: 'PR title',
      body: 'PR body',
      headRefName: 'feature/pr',
      baseRefName: 'main',
      comments: [
        {
          body: 'comment',
          author: { login: 'fares' },
          created_at: '2026-08-07',
        },
      ],
      reviews: [],
    })

    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      projectPath: '/repo',
      source: {
        type: 'pr',
        item: {
          number: 42,
          title: 'PR title',
          headRefName: 'feature/pr',
          baseRefName: 'main',
        } as never,
      },
      baseBranch: 'wrong-branch',
    })

    expect(invoke).toHaveBeenCalledWith('get_github_pr', {
      projectPath: '/repo',
      prNumber: 42,
    })
    expect(result.baseBranch).toBeUndefined()
    expect(result.prContext?.comments).toEqual([
      {
        body: 'comment',
        author: { login: 'fares' },
        createdAt: '2026-08-07',
      },
    ])
  })

  it('uses a stacked PR head branch without fetching PR context', async () => {
    const invoke = vi.fn()
    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      source: {
        type: 'stack-pr',
        item: { headRefName: 'feature/pr' } as never,
      },
    })

    expect(result.baseBranch).toBe('feature/pr')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('loads complete issue context', async () => {
    const invoke = vi.fn().mockResolvedValue({
      number: 12,
      title: 'Issue title',
      body: 'Issue body',
      comments: [],
    })
    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      projectPath: '/repo',
      source: { type: 'issue', item: { number: 12 } as never },
    })

    expect(invoke).toHaveBeenCalledWith('get_github_issue', {
      projectPath: '/repo',
      issueNumber: 12,
    })
    expect(result.issueContext).toMatchObject({
      number: 12,
      title: 'Issue title',
    })
  })

  it.each([
    ['linear', 'get_linear_issue', 'linearContext'],
    ['sentry', 'get_sentry_issue', 'sentryContext'],
  ] as const)('loads %s context', async (type, command, contextKey) => {
    const detail =
      type === 'linear'
        ? { id: 'lin-1', identifier: 'JEAN-1', title: 'Linear', comments: null }
        : { id: 'sen-1', shortId: 'JEAN-1', title: 'Sentry' }
    const invoke = vi.fn().mockResolvedValue(detail)
    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      source: { type, item: { id: detail.id } } as never,
    })

    expect(invoke).toHaveBeenCalledWith(command, {
      projectId: 'project-1',
      issueId: detail.id,
    })
    expect(result[contextKey]).toBeDefined()
  })

  it('loads a Dependabot alert as security context', async () => {
    const alert = {
      number: 7,
      packageName: 'react',
      packageEcosystem: 'npm',
      severity: 'high',
      summary: 'Alert',
      description: 'Description',
      ghsaId: 'GHSA-1',
      manifestPath: 'package.json',
    }
    const invoke = vi.fn().mockResolvedValue(alert)
    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      projectPath: '/repo',
      source: { type: 'security', item: alert as never },
    })

    expect(invoke).toHaveBeenCalledWith('get_dependabot_alert', {
      projectPath: '/repo',
      alertNumber: 7,
    })
    expect(result.securityContext?.ghsaId).toBe('GHSA-1')
  })

  it('loads repository advisory context', async () => {
    const advisory = {
      ghsaId: 'GHSA-2',
      severity: 'critical',
      summary: 'Advisory',
      description: 'Description',
      vulnerabilities: [],
    }
    const invoke = vi.fn().mockResolvedValue(advisory)
    const result = await resolveWorktreeCreateArgs(invoke, {
      projectId: 'project-1',
      projectPath: '/repo',
      source: { type: 'advisory', item: advisory as never },
    })

    expect(invoke).toHaveBeenCalledWith('get_repository_advisory', {
      projectPath: '/repo',
      ghsaId: 'GHSA-2',
    })
    expect(result.advisoryContext?.severity).toBe('critical')
  })
})

describe('finishNewSessionFlow', () => {
  it('reuses the backend-created session and persists its settings', async () => {
    const invoke = vi.fn(async command => {
      if (command === 'get_sessions') return { sessions: [session] }
      return undefined
    })

    const result = await finishNewSessionFlow({
      pendingWorktree: worktree,
      waitForWorktree: vi.fn().mockResolvedValue(worktree),
      invoke: invoke as never,
      queuedMessage,
    })

    expect(result).toEqual({ worktree, session })
    expect(invoke.mock.calls.map(call => call[0])).toEqual([
      'get_sessions',
      'set_session_model',
      'set_session_backend',
      'update_session_state',
    ])
    expect(invoke).toHaveBeenLastCalledWith('update_session_state', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId: session.id,
      selectedExecutionMode: 'yolo',
    })
  })

  it('creates a session when the backend did not create one', async () => {
    const invoke = vi.fn(async command => {
      if (command === 'get_sessions') return { sessions: [] }
      if (command === 'create_session') return session
      return undefined
    })

    await finishNewSessionFlow({
      pendingWorktree: worktree,
      waitForWorktree: vi.fn().mockResolvedValue(worktree),
      invoke: invoke as never,
      queuedMessage,
    })

    expect(invoke).toHaveBeenCalledWith('create_session', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      backend: 'claude',
    })
  })

  it('creates a fresh conversation instead of reconfiguring project-folder history', async () => {
    const historicalSessions = [
      { ...session, id: 'historical-1' },
      { ...session, id: 'historical-2' },
    ]
    const freshSession = { ...session, id: 'fresh-project-conversation' }
    const invoke = vi.fn(async command => {
      if (command === 'get_sessions') return { sessions: historicalSessions }
      if (command === 'create_session') return freshSession
      return undefined
    })

    const result = await finishNewSessionFlow({
      pendingWorktree: worktree,
      waitForWorktree: vi.fn().mockResolvedValue(worktree),
      invoke: invoke as never,
      queuedMessage,
      createFreshSession: true,
    })

    expect(result.session).toEqual(freshSession)
    expect(invoke).toHaveBeenCalledWith('create_session', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      backend: 'claude',
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'set_session_model',
      expect.objectContaining({ sessionId: 'historical-1' })
    )
    expect(invoke).not.toHaveBeenCalledWith(
      'set_session_model',
      expect.objectContaining({ sessionId: 'historical-2' })
    )
  })
})

describe('startNewSessionPrompt', () => {
  it('dispatches the queued prompt directly after setup instead of waiting for a chat view', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const queuedMessage = {
      id: 'queued-1',
      message: 'Implement this now',
      pendingImages: [],
      pendingFiles: [],
      pendingSkills: [],
      pendingTextFiles: [],
      model: 'claude-opus-4-8[1m]',
      provider: null,
      executionMode: 'yolo',
      thinkingLevel: 'off',
      backend: 'claude',
      queuedAt: 1,
    } as QueuedMessage

    await startNewSessionPrompt(
      invoke,
      { id: 'worktree-1', path: '/repo/worktree-1' } as never,
      { id: 'session-1' } as never,
      queuedMessage
    )

    expect(invoke).toHaveBeenCalledWith('send_chat_message', {
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      worktreePath: '/repo/worktree-1',
      message: 'Implement this now',
      model: 'claude-opus-4-8[1m]',
      executionMode: 'yolo',
      thinkingLevel: 'off',
      backend: 'claude',
    })
  })
})

describe('prepareWorktreeCreationTracker', () => {
  it('buffers fast creation and setup events emitted before the worktree id is known', async () => {
    const handlers = new Map<string, (event: { payload: never }) => void>()
    const unlisten = vi.fn()
    const tracker = await prepareWorktreeCreationTracker(
      vi.fn(async (event, handler) => {
        handlers.set(event, handler)
        return unlisten
      })
    )

    handlers.get('worktree:created')?.({
      payload: { worktree } as never,
    })
    handlers.get('worktree:setup_complete')?.({
      payload: { id: worktree.id } as never,
    })

    await expect(tracker.waitForCreated(worktree.id, 100)).resolves.toEqual(
      worktree
    )
    await expect(
      tracker.waitForSetup(worktree.id, 100)
    ).resolves.toBeUndefined()
    tracker.dispose()
    expect(unlisten).toHaveBeenCalledTimes(3)
  })

  it('keeps concurrent creation and setup waiters registered independently', async () => {
    const handlers = new Map<string, (event: { payload: never }) => void>()
    const tracker = await prepareWorktreeCreationTracker(
      vi.fn(async (event, handler) => {
        handlers.set(event, handler)
        return vi.fn()
      })
    )
    const createdPromise = tracker.waitForCreated(worktree.id, 100)
    const setupPromise = tracker.waitForSetup(worktree.id, 100)

    handlers.get('worktree:created')?.({
      payload: { worktree } as never,
    })
    await expect(createdPromise).resolves.toEqual(worktree)

    handlers.get('worktree:setup_complete')?.({
      payload: { id: worktree.id } as never,
    })
    await expect(setupPromise).resolves.toBeUndefined()
    tracker.dispose()
  })
})
