import { useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { parseServerResourceKey } from '@/lib/server-resource'
import { useWorktree } from '@/services/projects'
import {
  useAgentDetails,
  useDecideAgentApproval,
  useRevertAgentChange,
  type AgentApproval,
  type AgentChange,
  type AgentDelegation,
  type AgentSummary,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import {
  agentChangeActorLabel,
  agentChangeDetail,
  latestChangeIdForTarget,
} from './agent-changes'
import {
  AgentBadge,
  AgentEmpty,
  AgentList,
  AgentNotice,
  AgentSection,
  AgentTabBody,
  statusTone,
} from './agent-ui'

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
  if (
    approval.tool === 'agent_update' ||
    approval.tool === 'agent_delete' ||
    approval.tool === 'agent_revert'
  ) {
    const who =
      (typeof args.targetName === 'string' && args.targetName) ||
      (typeof args.agentId === 'string' && args.agentId) ||
      (typeof args.name === 'string' && args.name) ||
      ''
    const verb =
      approval.tool === 'agent_delete'
        ? 'Delete agent'
        : approval.tool === 'agent_revert'
          ? 'Revert the last change to'
          : 'Update agent'
    return `${verb} ${who}`.trim()
  }
  const target =
    (args.worktreeId as string | undefined) ??
    (args.worktreePath as string | undefined) ??
    (args.projectId as string | undefined) ??
    ''
  const labels: Record<string, string> = {
    delete_worktree: 'Delete worktree',
    permanently_delete_worktree: 'Permanently delete worktree',
    push_worktree: 'Push worktree',
    merge_pull_request: 'Merge pull request of worktree',
    create_pull_request: 'Create pull request for worktree',
    remove_project: 'Remove project',
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
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          <span className="mr-1.5 text-muted-foreground">#{approval.id}</span>
          {describeApproval(approval)}
          {worktree ? (
            <span className="text-muted-foreground"> ({worktree.name})</span>
          ) : null}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(approval.args)}
        </p>
        {approval.status !== 'pending' && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AgentBadge tone={statusTone(approval.status)}>
              {approval.status}
            </AgentBadge>
            {approval.result ? (
              <span
                className={cn(
                  'truncate',
                  approval.status === 'failed' && 'text-destructive'
                )}
              >
                {approval.result}
              </span>
            ) : null}
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
    <div className="shrink-0 border-b bg-amber-500/5 px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          The agent waits for your approval
        </p>
        <AgentList className="bg-background">
          {pending.map(approval => (
            <ApprovalRow key={approval.id} approval={approval} />
          ))}
        </AgentList>
      </div>
    </div>
  )
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
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate text-foreground">
            {isAgentSession
              ? 'Agent request'
              : (worktree?.name ?? delegation.worktreeId)}
          </span>
          <AgentBadge tone={statusTone(delegation.status)}>
            {delegation.status}
          </AgentBadge>
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

function ChangeRow({
  change,
  canRevert,
  agentId,
}: {
  change: AgentChange
  canRevert: boolean
  agentId: string
}) {
  const revert = useRevertAgentChange()
  const detail = agentChangeDetail(change)
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{change.summary}</p>
        <p className="text-xs text-muted-foreground">
          {agentChangeActorLabel(change.actorAgentId)} ·{' '}
          {formatRelative(change.createdAt)}
        </p>
        {detail ? (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      {canRevert && (
        <Button
          size="sm"
          variant="outline"
          disabled={revert.isPending}
          onClick={() => {
            const id = toast.loading('Reverting change…')
            revert.mutate(
              { agentId, changeId: change.id },
              {
                onSuccess: () => toast.success('Change reverted', { id }),
                onError: error =>
                  toast.error(`Failed to revert: ${error}`, { id }),
              }
            )
          }}
        >
          Revert
        </Button>
      )}
    </li>
  )
}

function Section({
  title,
  description,
  empty,
  children,
}: {
  title: string
  description: string
  empty: string
  children: React.ReactNode[]
}) {
  return (
    <AgentSection
      title={title}
      count={children.length}
      description={description}
    >
      {children.length > 0 ? (
        <AgentList>{children}</AgentList>
      ) : (
        <AgentEmpty title={empty} />
      )}
    </AgentSection>
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
  const pending = data.approvals.filter(a => a.status === 'pending')
  const decided = data.approvals.filter(a => a.status !== 'pending')
  return (
    <AgentTabBody>
      {agent.budgetReached && (
        <AgentNotice>
          Hourly limit reached ({agent.maxWakesPerHour} wake-ups). Updates wait
          until the next hour.
        </AgentNotice>
      )}
      <Section
        title="Approvals"
        description="Destructive actions the agent asked you to allow."
        empty="No approval requests."
      >
        {[...pending, ...decided].map(approval => (
          <ApprovalRow key={approval.id} approval={approval} />
        ))}
      </Section>
      <Section
        title="Followed sessions"
        description="Project sessions the agent started or watches."
        empty="The agent does not follow any session yet."
      >
        {data.delegations.map(delegation => (
          <DelegationRow key={delegation.id} delegation={delegation} />
        ))}
      </Section>
      <Section
        title="Changes"
        description="Edits to agents made through self-management. The latest change per agent can be reverted."
        empty="No self-management changes yet."
      >
        {data.changes.map(change => (
          <ChangeRow
            key={change.id}
            change={change}
            agentId={agent.id}
            canRevert={
              change.id ===
              latestChangeIdForTarget(
                data.changes,
                parseServerResourceKey(agent.id)?.resourceId ?? agent.id
              )
            }
          />
        ))}
      </Section>
    </AgentTabBody>
  )
}
