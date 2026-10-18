import { useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { parseServerResourceKey } from '@/lib/server-resource'
import { useWorktree } from '@/services/projects'
import {
  useAgentDetails,
  useDecideAgentApproval,
  type AgentApproval,
  type AgentDelegation,
  type AgentSummary,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

/** "5m ago" / "in 2h" for unix seconds. */
export function formatRelative(unixSeconds: number, now = Date.now()): string {
  const diff = Math.round(unixSeconds - now / 1000)
  const abs = Math.abs(diff)
  const value =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86_400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86_400)}d`
  if (abs < 5) return 'now'
  return diff > 0 ? `in ${value}` : `${value} ago`
}

/** One line that says what an approval will do. */
export function describeApproval(approval: AgentApproval): string {
  const args = approval.args ?? {}
  const target =
    (args.worktreeId as string | undefined) ??
    (args.worktreePath as string | undefined) ??
    ''
  const labels: Record<string, string> = {
    delete_worktree: 'Delete worktree',
    permanently_delete_worktree: 'Permanently delete worktree',
    push_worktree: 'Push worktree',
    merge_pull_request: 'Merge pull request of worktree',
    create_pull_request: 'Create pull request for worktree',
  }
  return `${labels[approval.tool] ?? approval.tool} ${target}`.trim()
}

function ApprovalRow({ approval }: { approval: AgentApproval }) {
  const decide = useDecideAgentApproval()
  const { data: worktree } = useWorktree(
    (approval.args?.worktreeId as string | undefined) ?? null
  )
  const run = (approve: boolean) =>
    decide.mutate(
      { agentId: approval.agentId, approvalId: approval.id, approve },
      {
        onSuccess: result =>
          result.status === 'failed'
            ? toast.error(`#${approval.id} failed: ${result.result}`)
            : toast.success(
                approve ? `#${approval.id} approved` : `#${approval.id} denied`
              ),
        onError: e => toast.error(`Failed: ${e}`),
      }
    )
  return (
    <li className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          #{approval.id} {describeApproval(approval)}
          {worktree ? (
            <span className="text-muted-foreground"> ({worktree.name})</span>
          ) : null}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(approval.args)}
        </p>
        {approval.status !== 'pending' && (
          <p
            className={cn(
              'text-xs',
              approval.status === 'failed'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {approval.status}
            {approval.result ? `: ${approval.result}` : ''}
          </p>
        )}
      </div>
      {approval.status === 'pending' && (
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => run(false)}
          >
            Deny
          </Button>
          <Button
            size="sm"
            disabled={decide.isPending}
            onClick={() => run(true)}
          >
            Approve
          </Button>
        </div>
      )}
    </li>
  )
}

/** Pending approvals above the agent chat. */
export function PendingApprovals({ agentId }: { agentId: string }) {
  const { data } = useAgentDetails(agentId)
  const pending = data?.approvals.filter(a => a.status === 'pending') ?? []
  if (pending.length === 0) return null
  return (
    <div className="shrink-0 border-b bg-amber-500/5 px-4 py-2">
      <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        The agent waits for your approval
      </p>
      <ul className="space-y-2">
        {pending.map(approval => (
          <ApprovalRow key={approval.id} approval={approval} />
        ))}
      </ul>
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  active: 'text-primary',
  waiting: 'text-amber-600 dark:text-amber-400',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  done: 'text-muted-foreground',
}

function DelegationRow({ delegation }: { delegation: AgentDelegation }) {
  // Agent sessions use reserved IDs (also when scoped to a remote server)
  const isAgentSession = (
    parseServerResourceKey(delegation.worktreeId)?.resourceId ??
    delegation.worktreeId
  ).startsWith('__')
  const { data: worktree } = useWorktree(
    isAgentSession ? null : delegation.worktreeId
  )

  const open = useCallback(() => {
    if (!worktree) return
    const { selectProject, selectWorktree } = useProjectsStore.getState()
    selectProject(worktree.project_id)
    selectWorktree(worktree.id)
    const chat = useChatStore.getState()
    chat.registerWorktreePath(worktree.id, worktree.path)
    chat.clearActiveWorktree()
    chat.setActiveSession(worktree.id, delegation.sessionId)
    const ui = useUIStore.getState()
    ui.markWorktreeForAutoOpenSession(worktree.id, delegation.sessionId)
    // Leave the Agents page so the project canvas can open the session
    ui.setRailSection('workspace')
  }, [worktree, delegation.sessionId])

  return (
    <li className="flex items-start gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="truncate text-foreground">
            {isAgentSession
              ? 'Agent request'
              : (worktree?.name ?? delegation.worktreeId)}
          </span>
          <span
            className={cn('shrink-0 text-xs', STATUS_STYLES[delegation.status])}
          >
            {delegation.status}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelative(delegation.updatedAt)}
          </span>
        </p>
        {delegation.lastSummary ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {delegation.lastSummary}
          </p>
        ) : null}
      </div>
      {worktree && (
        <Button size="sm" variant="ghost" onClick={open}>
          Open
        </Button>
      )}
    </li>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode[]
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children.length > 0 ? (
        <ul className="space-y-2">{children}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </section>
  )
}

/** Approvals and followed sessions of an agent. */
export function AgentActivity({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading activity…
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
      {agent.budgetReached && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Hourly limit reached ({agent.maxWakesPerHour} wake-ups). Updates wait
          until the next hour.
        </p>
      )}
      <Section title="Approvals" empty="No approval requests.">
        {data.approvals.map(approval => (
          <ApprovalRow key={approval.id} approval={approval} />
        ))}
      </Section>
      <Section
        title="Followed sessions"
        empty="The agent does not follow any session yet."
      >
        {data.delegations.map(delegation => (
          <DelegationRow key={delegation.id} delegation={delegation} />
        ))}
      </Section>
    </div>
  )
}
