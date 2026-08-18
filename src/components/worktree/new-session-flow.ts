import type { UnlistenFn } from '@/lib/transport'
import type { QueuedMessage, Session, WorktreeSessions } from '@/types/chat'
import type {
  Worktree,
  WorktreeCreatedEvent,
  WorktreeCreateErrorEvent,
  WorktreeSetupCompleteEvent,
} from '@/types/projects'
import type {
  AdvisoryContext,
  DependabotAlert,
  GitHubIssue,
  GitHubPullRequest,
  IssueContext,
  PullRequestContext,
  RepositoryAdvisory,
  SecurityAlertContext,
} from '@/types/github'
import type { LinearIssueDetail } from '@/types/linear'
import type { SentryIssueContext } from '@/types/sentry'
import type { NewSessionSource } from './new-session-draft'
import { buildMessageWithRefs } from '@/components/chat/message-with-refs'

export interface WorktreeCreateArgs {
  projectId: string
  baseBranch?: string
  customName?: string
  issueContext?: IssueContext
  prContext?: PullRequestContext
  securityContext?: SecurityAlertContext
  advisoryContext?: AdvisoryContext
  linearContext?: LinearIssueDetail
  sentryContext?: SentryIssueContext
  background: boolean
}

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>

export async function resolveWorktreeCreateArgs(
  invoke: Invoke,
  input: {
    projectId: string
    projectPath?: string
    source: NewSessionSource | null
    baseBranch?: string
    customName?: string
  }
): Promise<WorktreeCreateArgs> {
  const args: WorktreeCreateArgs = {
    projectId: input.projectId,
    baseBranch: input.baseBranch,
    customName: input.customName || undefined,
    background: true,
  }
  const source = input.source
  if (!source) return args

  if (source.type === 'base') return args
  if (source.type === 'branch') return { ...args, baseBranch: source.branch }
  if (source.type === 'stack-pr') {
    return { ...args, baseBranch: source.item.headRefName }
  }
  if (source.type === 'linear') {
    const detail = await invoke<LinearIssueDetail>('get_linear_issue', {
      projectId: input.projectId,
      issueId: source.item.id,
    })
    return {
      ...args,
      linearContext: { ...detail, comments: detail.comments ?? [] },
    }
  }
  if (source.type === 'sentry') {
    const sentryContext = await invoke<SentryIssueContext>('get_sentry_issue', {
      projectId: input.projectId,
      issueId: source.item.id,
    })
    return { ...args, sentryContext }
  }
  if (!input.projectPath) throw new Error('Project path is required')

  if (source.type === 'issue') {
    const detail = await invoke<GitHubIssue & { comments?: GhComment[] }>(
      'get_github_issue',
      { projectPath: input.projectPath, issueNumber: source.item.number }
    )
    return {
      ...args,
      issueContext: {
        number: detail.number,
        title: detail.title,
        body: detail.body,
        comments: mapComments(detail.comments),
      },
    }
  }
  if (source.type === 'pr') {
    const detail = await invoke<
      GitHubPullRequest & { comments?: GhComment[]; reviews?: GhReview[] }
    >('get_github_pr', {
      projectPath: input.projectPath,
      prNumber: source.item.number,
    })
    return {
      ...args,
      baseBranch: undefined,
      prContext: {
        number: detail.number,
        title: detail.title,
        body: detail.body,
        headRefName: detail.headRefName,
        baseRefName: detail.baseRefName,
        comments: mapComments(detail.comments),
        reviews: (detail.reviews ?? []).flatMap(review =>
          review?.author
            ? [
                {
                  body: review.body ?? '',
                  state: review.state,
                  author: { login: review.author.login ?? '' },
                  submittedAt: review.submittedAt,
                },
              ]
            : []
        ),
      },
    }
  }
  if (source.type === 'security') {
    const detail = await invoke<DependabotAlert>('get_dependabot_alert', {
      projectPath: input.projectPath,
      alertNumber: source.item.number,
    })
    return { ...args, securityContext: securityContext(detail) }
  }

  const detail = await invoke<RepositoryAdvisory>('get_repository_advisory', {
    projectPath: input.projectPath,
    ghsaId: source.item.ghsaId,
  })
  return {
    ...args,
    advisoryContext: {
      ghsaId: detail.ghsaId,
      severity: detail.severity,
      summary: detail.summary,
      description: detail.description,
      cveId: detail.cveId,
      vulnerabilities: detail.vulnerabilities.map(item => ({
        packageName: item.packageName,
        packageEcosystem: item.packageEcosystem,
        vulnerableVersionRange: item.vulnerableVersionRange,
        patchedVersions: item.patchedVersions,
      })),
      htmlUrl: detail.htmlUrl,
    },
  }
}

interface GhComment {
  body?: string
  author?: { login?: string }
  created_at?: string
}

interface GhReview {
  body?: string
  state: string
  author?: { login?: string }
  submittedAt?: string
}

function mapComments(
  comments: GhComment[] | undefined
): IssueContext['comments'] {
  return (comments ?? []).flatMap(comment =>
    comment?.author && comment.created_at
      ? [
          {
            body: comment.body ?? '',
            author: { login: comment.author.login ?? '' },
            createdAt: comment.created_at,
          },
        ]
      : []
  )
}

function securityContext(detail: DependabotAlert): SecurityAlertContext {
  return {
    number: detail.number,
    packageName: detail.packageName,
    packageEcosystem: detail.packageEcosystem,
    severity: detail.severity,
    summary: detail.summary,
    description: detail.description,
    ghsaId: detail.ghsaId,
    cveId: detail.cveId,
    manifestPath: detail.manifestPath,
    htmlUrl: detail.htmlUrl,
  }
}

export async function finishNewSessionFlow(deps: {
  pendingWorktree: Worktree
  waitForWorktree: (worktreeId: string) => Promise<Worktree>
  waitForSetup?: (worktreeId: string) => Promise<void>
  invoke: Invoke
  queuedMessage?: QueuedMessage
  createFreshSession?: boolean
}): Promise<{ worktree: Worktree; session: Session }> {
  const setup = deps.waitForSetup?.(deps.pendingWorktree.id)
  const worktree = await deps.waitForWorktree(deps.pendingWorktree.id)
  await setup
  const sessions = await deps.invoke<WorktreeSessions>('get_sessions', {
    worktreeId: worktree.id,
    worktreePath: worktree.path,
  })
  const session =
    (!deps.createFreshSession ? sessions.sessions[0] : undefined) ??
    (await deps.invoke<Session>('create_session', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      backend: deps.queuedMessage?.backend,
    }))

  if (deps.queuedMessage) {
    await deps.invoke('set_session_model', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId: session.id,
      model: deps.queuedMessage.model,
    })
  }
  if (deps.queuedMessage?.backend) {
    await deps.invoke('set_session_backend', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId: session.id,
      backend: deps.queuedMessage.backend,
    })
  }
  if (deps.queuedMessage) {
    await deps.invoke('update_session_state', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId: session.id,
      selectedExecutionMode: deps.queuedMessage.executionMode,
    })
  }
  return { worktree, session }
}

export async function startNewSessionPrompt(
  invoke: Invoke,
  worktree: Worktree,
  session: Session,
  queuedMessage: QueuedMessage
): Promise<void> {
  await invoke('send_chat_message', {
    sessionId: session.id,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    message: buildMessageWithRefs(queuedMessage),
    model: queuedMessage.model,
    executionMode: queuedMessage.executionMode,
    thinkingLevel: queuedMessage.thinkingLevel,
    backend: queuedMessage.backend,
  })
}

/**
 * Registers creation listeners before the backend command is dispatched.
 * Fast repositories can emit `worktree:created` before an invoke promise has
 * returned, so listeners installed afterwards are inherently racy.
 */
export async function prepareWorktreeCreationTracker(
  listen: <T>(
    event: string,
    handler: (event: { payload: T }) => void
  ) => Promise<UnlistenFn>
): Promise<{
  waitForCreated: (worktreeId: string, timeoutMs?: number) => Promise<Worktree>
  waitForSetup: (worktreeId: string, timeoutMs?: number) => Promise<void>
  dispose: () => void
}> {
  const created = new Map<string, Worktree>()
  const errors = new Map<string, Error>()
  const setups = new Set<string>()
  const wakeups = new Map<string, Set<() => void>>()
  const wake = (id: string) => {
    ;[...(wakeups.get(id) ?? [])].forEach(check => check())
  }
  const unlisteners = await Promise.all([
    listen<WorktreeCreatedEvent>('worktree:created', event => {
      created.set(event.payload.worktree.id, event.payload.worktree)
      wake(event.payload.worktree.id)
    }),
    listen<WorktreeCreateErrorEvent>('worktree:error', event => {
      errors.set(event.payload.id, new Error(event.payload.error))
      wake(event.payload.id)
    }),
    listen<WorktreeSetupCompleteEvent>('worktree:setup_complete', event => {
      setups.add(event.payload.id)
      wake(event.payload.id)
    }),
  ])

  const waitFor = <T>(
    id: string,
    read: () => T | undefined,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const error = errors.get(id)
        if (error) {
          cleanup()
          reject(error)
          return
        }
        const value = read()
        if (value !== undefined) {
          cleanup()
          resolve(value)
        }
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(timeoutMessage))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timeout)
        const listeners = wakeups.get(id)
        listeners?.delete(check)
        if (listeners?.size === 0) wakeups.delete(id)
      }
      const listeners = wakeups.get(id) ?? new Set()
      listeners.add(check)
      wakeups.set(id, listeners)
      check()
    })

  return {
    waitForCreated: (id, timeoutMs = 120_000) =>
      waitFor(
        id,
        () => created.get(id),
        timeoutMs,
        'Worktree creation timed out'
      ),
    waitForSetup: (id, timeoutMs = 120_000) =>
      waitFor(
        id,
        () => (setups.has(id) ? true : undefined),
        timeoutMs,
        'Project setup timed out'
      ).then(() => undefined),
    dispose: () => {
      unlisteners.forEach(unlisten => unlisten())
      wakeups.clear()
    },
  }
}
